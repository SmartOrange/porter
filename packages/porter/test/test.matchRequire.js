'use strict'

const expect = require('expect.js')
const path = require('path')
const { readFile } = require('mz/fs')
const matchRequire = require('../lib/matchRequire')

const root = path.join(__dirname, '../../porter-app')

describe('matchRequire', function() {
  it('match require call statement', async function () {
    const code = await readFile(path.join(root, 'components/home.js'), 'utf8')
    const deps = matchRequire.findAll(code)

    expect(deps).to.contain('yen')
    // do not look into strings or comments
    expect(deps).to.not.contain('cropper/dist/cropper.css')
  })

  it('match import declaration', function () {
    const deps = matchRequire.findAll(`
      import * as yen from 'yen'
      import traverse from 'babel-traverse'

      const code = \`
        require('cropper')
        import $ from 'jquery'
      \`

      const css = '@import "cropper/dist/cropper.css"'
    `)
    expect(deps).to.eql(['yen', 'babel-traverse'])
  })

  it('match conditional require call statements', async function() {
    const deps = matchRequire.findAll(`
      if ("development" == "development") {
        require('jquery')
      } else {
        require('yen')
      }
    `)
    expect(deps).to.eql(['jquery'])
  })

  it('should not hang while parsing following code', async function() {
    const deps = matchRequire.findAll(`
    if ('production' !== 'production') {
      Object.freeze(emptyObject);
    }
    `)
    expect(deps).to.eql([])
  })
})