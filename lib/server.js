'use strict'

const bs58 = require('bs58')
const crypto = require('crypto')
const EventEmitter = require('events')
const https = require('https')
const { promisify } = require('util')
const WebSocket = require('ws')

const randBytes = promisify(crypto.randomBytes)

const send = (conn, msg, close) => {
  conn.send(JSON.stringify(msg))
  close && conn.close()
}

const respond = (conn, req, resp, close) => {
  resp.id = req.id
  send(conn, resp, close)
}

const slowHash = async (password, salt) => {
  salt = salt || await randBytes(16)

  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(password), salt, 64, (err, hash) => {
      err ? reject(err) : resolve(hash)
    })
  })

  return { hash, salt }
}

class Server extends EventEmitter {
  constructor (opts) {
    super()

    this.chats = new Map()

    const server = this.https = https.createServer(opts)
    this.ws = new WebSocket.Server({ server })

    this.ws.on('connection', async conn => {
      try {
        await this.handleConn(conn)
      } catch (err) {
        send(conn, { message: 'Internal Server Error', code: 500 }, true)
        this.emit('error', err)
      }
    })
  }

  async genChatId () {
    const buf = await randBytes(5)

    let id

    for (let i = 3; i <= 5; i++) {
      id = bs58.encode(buf.slice(0, i))
      const chat = await this.chats.get(id)
      if (!chat) return id
    }

    throw new Error('Service unavailable')
  }

  start (...args) {
    return new Promise(resolve => this.https.listen(...args, resolve))
  }

  stop () {
    this.ws.close()
    this.https.close()
  }

  async startChat (conn, req) {
    const { name, password } = req.data

    const [{ hash, salt }, id] = await Promise.all([
      slowHash(password),
      this.genChatId()
    ])

    const conns = new Map()
    conns.set(name, conn)

    const chat = { id, hash, salt, conns }

    this.chats.set(id, chat)

    return chat
  }

  async joinChat (conn, req) {
    const { chatId, name, password } = req.data
    const chat = this.chats.get(chatId)

    if (!chat) {
      respond(conn, req, { message: 'Chat not found', code: 404 }, true)
      return
    }

    if (chat.conns.get(name)) {
      respond(conn, req, { message: 'Member already has that name', code: 409 }, true)
      return
    }

    const { hash } = await slowHash(password, chat.salt)

    if (!crypto.timingSafeEqual(hash, chat.hash)) {
      respond(conn, req, { message: 'Invalid password', code: 401 }, true)
      return
    }

    chat.conns.set(name, conn)

    return chat
  }

  async handleConn (conn) {
    let [req] = await EventEmitter.once(conn, 'message')

    try {
      req = JSON.parse(req.data)
    } catch (err) {
      respond(conn, {}, { message: 'Invalid message', code: 400 }, true)
      return
    }

    const data = {}

    let chat

    if (req.type === 'start') {
      chat = await this.startChat(conn, req)
      data.chatId = chat.id
    } else if (req.type === 'join') {
      if (!(chat = await this.joinChat(conn, req))) return
      data.members = [...chat.conns.keys()].filter(key => key !== req.data.name)
    } else {
      respond(conn, req, { message: 'Expected start or join request', code: 400 }, true)
      return
    }

    respond(conn, req, { message: 'Connected', code: 200, data })

    conn.on('message', msg => {
      try {
        this.handleMessage({ chat, conn, msg, name: req.data.name })
      } catch (err) {
        this.emit('error', err)
      }
    })
  }

  handleMessage ({ chat, conn, msg, name }) {
    try {
      msg = JSON.parse(msg)
    } catch {
      send(conn, { message: 'Invalid message', code: 400 })
      return
    }

    switch (msg.type) {
      case 'candidate':
      case 'offer':
      case 'answer':
        this.forwardMessage({ chat, conn, msg, name })
        return

      default:
        send(conn, { message: 'Invalid message type', code: 405 })
    }
  }

  forwardMessage ({ chat, conn, msg, name }) {
    const peerConn = chat.conns.get(msg.data.to)

    if (!peerConn) {
      send(conn, { message: 'Member not found', code: 404 })
      return
    }

    msg.data.from = name

    send(peerConn, msg)
  }
}

module.exports = Server
