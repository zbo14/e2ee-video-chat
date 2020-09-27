'use strict'

const fs = require('fs')
const path = require('path')
const Server = require('./lib/server')

const priv = path.join(__dirname, 'private')
const cert = fs.readFileSync(path.join(priv, 'cert.pem'))
const key = fs.readFileSync(path.join(priv, 'key.pem'))

const server = new Server({ cert, key })

server
  .on('error', console.error)
  .start(8901)
  .then(() => console.log('Server started!'))
