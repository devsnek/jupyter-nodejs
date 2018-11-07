'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const installPath = path.resolve(os.homedir(), '.ipython/kernels/nodejs');

fs.writeFileSync(path.join(installPath, 'kernel.json'), JSON.stringify({
  argv: ['node', path.join(path.resolve(__dirname), 'index.js'), '{connection_file}'],
  display_name: 'Node.js',
  language: 'JavaScript',
}, null, 2));
