'use strict';

const expect = require('expect.js');

describe('require json', function() {
  it('require("./foo.json")', function() {
    expect(require('./foo.json')).to.eql({
      foo: 1,
      bar: true
    });
  });
});
