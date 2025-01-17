'use strict';

const path = require('path');
const Porter = require('@cara/porter');

module.exports = new Porter({
  root: path.join(__dirname, '..'),
  paths: ['components', 'browser_modules'],
  dest: 'public',
  source: {
    serve: true,
    root: 'http://localhost:3000',
  },
  preload: 'preload',
  bundle: {
    exclude: ['react', 'react-dom'],
  }
});
