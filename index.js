'use strict';

const zmq = require('zeromq');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const vm = require('vm');
const recast = require('recast');
const acorn = require('acorn');
const walk = require('acorn-walk');
const Module = require('module');

function rewriteCode(source) {
  const ast = recast.parse(source, {
    parser: {
      parse: (s) => acorn.parse(s, { ecmaVersion: 2019 }),
    },
  });

  const b = recast.types.builders;

  walk.ancestor(ast.program, {
    VariableDeclaration(node) {
      node.kind = 'var';
    },
    ClassDeclaration(node, ancestors) {
      const declaration = b.variableDeclaration('var', [
        b.variableDeclarator(node.id, { ...node, type: 'ClassExpression' }),
      ]);
      const parent = ancestors[0];
      const index = parent.body.indexOf(node);
      parent.body[index] = declaration;
    },
  });

  return recast.print(ast).code;
}

const config = require(path.resolve(process.argv[2]));

function createSocket(type, address, port) {
  return new Promise((resolve, reject) => {
    const sock = zmq.socket(type);
    sock.bind(`${address}:${port}`, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(sock);
      }
    });
  });
}

function uuid() {
  return Math.random().toString(0x0f).slice(10, 100);
}

const DELIM = '<IDS|MSG>';
function parse(...args) {
  const strs = args.map((a) => a.toString());
  const i = strs.indexOf(DELIM);
  const uuids = args.slice(0, i);
  const [header, /* parentHeader */, /* metadata */, content] = strs.slice(i + 2);

  return {
    header: JSON.parse(header),
    // metadata: JSON.parse(metadata),
    content: JSON.parse(content),
    uuids,
  };
}

const info = {
  protocol_version: '5.1',
  implementation: 'nodejs',
  implementation_version: '1.0',
  language: 'JavaScript',
  banner: 'Node.js for Jupyter',
  language_info: {
    name: 'Node.js',
    version: '0.10',
    mimetype: 'text/javascript',
    file_extension: '.js',
    pygments_lexer: 'javascript',
    codemirror_mode: 'javascript',
  },
  help_links: [
    { text: 'Node.js Documentation', url: 'https://nodejs.org/api/' },
    { text: 'JavaScript Documentation (MDN)', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
  ],
};

function send(socket, ids, type, content, parent, metadata = {}) {
  const replyId = uuid();
  const toHash = [
    JSON.stringify({
      msg_id: replyId,
      username: parent.username,
      msg_type: type,
      session: parent.session,
      version: '5.1',
    }),
    JSON.stringify(parent),
    JSON.stringify(metadata),
    JSON.stringify(content),
  ];
  const hmac = crypto.createHmac('sha256', config.key);
  hmac.update(toHash.join(''));
  const data = ids.concat([DELIM, hmac.digest('hex')]).concat(toHash);
  socket.send(data);
}

(async () => {
  const sockets = {
    control: undefined,
    shell: undefined,
    stdin: undefined,
    hb: undefined,
    iopub: undefined,
  };

  const address = `${config.transport}://${config.ip}`;

  sockets.hb = await createSocket('rep', address, config.hb_port);
  sockets.iopub = await createSocket('pub', address, config.iopub_port);
  sockets.control = await createSocket('router', address, config.control_port);
  sockets.stdin = await createSocket('router', address, config.stdin_port);
  sockets.shell = await createSocket('router', address, config.shell_port);

  function iopub(type, content, parent) {
    return send(sockets.iopub, [uuid()], type, content, parent);
  }

  sockets.hb.on('message', (data) => sockets.hb.send(data));

  const fmt = (...args) => `${util.format(...args)}\n`;

  const context = vm.createContext({
    require(id) {
      if (Module.builtinModules.includes(id)) {
        return require(id);
      }
      throw new Error(`Cannot find module '${id}'`);
    },
    setTimeout,
    setInterval,
    setImmediate,
    clearTimeout,
    clearInterval,
    clearImmediate,
    queueMicrotask,
    Buffer,
    console: undefined,
  });
  context.global = context;

  let executionCount = 0;
  sockets.shell.on('message', (...args) => {
    const data = parse(...args);
    if (data.header.msg_type === 'kernel_info_request') {
      send(sockets.shell, data.uuids, 'kernel_info_reply', info, data.header);
      return;
    }
    if (data.header.msg_type === 'execute_request') {
      iopub('status', { execution_state: 'busy' }, data.header);

      executionCount += 1;
      iopub('execute_input', {
        code: data.content.code,
        execution_count: executionCount,
      }, data.header);

      const log = (...a) => {
        const text = fmt(...a);
        iopub('stream', { name: 'stdout', text }, data.header);
      };
      const error = (...a) => {
        const text = fmt(...a);
        iopub('stream', { name: 'stderr', text }, data.header);
      };

      context.console = {
        log,
        debug: log,
        info: log,
        warn: error,
        error,
        dir: log,
        // time
        // timeEnd
        // timeLog
        trace(...a) {
          return log(new Error(util.format(...a)));
        },
        assert(condition, ...a) {
          if (!condition) {
            error('Assertion failed;', ...a);
          }
        },
        // count
        // countReset
        // group
        // groupCollapsed
        // groupEnd
        // table
        // profile
        // profileEnd
      };

      try {
        const result = util.inspect(
          vm.runInContext(
            rewriteCode(data.content.code),
            context,
            {
              filename: 'jupyter.js',
            },
          ),
          { depth: 2 },
        );
        iopub('execute_result', {
          execution_count: executionCount,
          data: { 'text/plain': result },
        }, data.header);
        send(sockets.shell, data.uuids, 'execute_reply', {
          status: 'ok',
          execution_count: executionCount,
          user_expressions: {},
          payload: [],
        }, data.header);
      } catch (e) {
        iopub('error', {
          ename: e.name,
          evalue: e.message,
          traceback: [e.stack],
        }, data.header);
        send(sockets.shell, data.uuids, 'execute_reply', {
          status: 'error',
          ename: e.name,
          evalue: e.message,
          traceback: [e.stack],
          execution_count: executionCount,
          user_expressions: {},
          payload: [],
        }, data.header);
      }
      iopub('status', { execution_state: 'idle' }, data.header);
    }
  });

  sockets.control.on('message', (...args) => {
    const data = parse(...args);
    if (data.header.msg_type === 'shutdown_request') {
      process.exit(0);
    }
  });
})();
