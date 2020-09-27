'use strict'

const EventEmitter = require('events')
const uuid = require('uuid').v4
const Peer = require('./peer')

class Client extends EventEmitter {
  constructor (Worker) {
    super()

    this.audioStream = null
    this.audioTrack = null
    this.chatId = ''
    this.name = ''
    this.numWorkers = navigator.hardwareConcurrency || 4
    this.peers = new Map()
    this.videoStream = null
    this.videoTrack = null
    this.workers = Array.from({ length: this.numWorkers }).map(() => new Worker())
    this.ws = null
  }

  async startStream () {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    this.audioTrack = this.stream.getAudioTracks()[0]
    this.videoTrack = this.stream.getVideoTracks()[0]
  }

  addTracks (peer) {
    const promises = [
      this.audioTrack && peer.addTrack(this.audioTrack, this.stream),
      this.videoTrack && peer.addTrack(this.videoTrack, this.stream)
    ].filter(Boolean)

    return Promise.all(promises)
  }

  async startChat ({ host, port, name, password }) {
    this.ws = new WebSocket(`wss://${host}:${port}`)

    await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Connect timeout')), 10e3)
      this.ws.addEventListener('open', resolve, { once: true })
    })

    const resp = await this.request('start', { name, password })

    this.ws.addEventListener('message', async msg => {
      try {
        await this.handleMessage(msg)
      } catch (err) {
        this.emit('error', err)
      }
    })

    const { chatId } = resp.data
    this.chatId = chatId
    this.name = name

    await this.startStream()

    return chatId
  }

  async joinChat ({ host, port, chatId, name, password }) {
    this.ws = new WebSocket(`wss://${host}:${port}`)

    await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Connect timeout')), 10e3)
      this.ws.addEventListener('open', resolve, { once: true })
    })

    const resp = await this.request('join', { chatId, name, password })

    this.ws.addEventListener('message', async msg => {
      try {
        await this.handleMessage(msg)
      } catch (err) {
        this.emit('error', err)
      }
    })

    this.chatId = chatId
    this.name = name

    await this.startStream()

    const promises = resp.data.members.map(name => this.createPeerConnection({ name }))

    await Promise.all(promises)
  }

  async createPeerConnection ({ name, bundle }) {
    const worker = this.workers[this.peers.size % this.workers.length]
    const peer = new Peer({ client: this, name, worker })

    this.peers.set(name, peer)

    if (bundle) {
      const pubKey = Buffer.from(bundle.pubKey, 'base64')

      const [salt] = await Promise.all([
        peer.computeSecret({ pubKey, name: this.name }),
        peer.setRemoteDescription(bundle.offer),
        this.addTracks(peer)
      ])

      const answer = await peer.createAnswer()

      this.send('answer', {
        answer,
        pubKey: peer.pubKey,
        salt: salt.toString('base64'),
        to: name
      })

      return
    }

    await this.addTracks(peer)

    const offer = await peer.createOffer()

    this.send('offer', { offer, pubKey: peer.pubKey, to: name })
  }

  send (type, data, id) {
    this.ws.send(JSON.stringify({ type, data, id }))
  }

  async request (type, data) {
    const id = uuid()

    const promise = new Promise((resolve, reject) => {
      const listener = msg => {
        try {
          msg = JSON.parse(msg.data)
        } catch {
          return
        }

        if (msg.id === id) {
          resolve(msg)
          this.ws.removeEventListener('message', listener)
        }
      }

      setTimeout(() => reject(new Error('Request timeout')), 10e3)

      this.ws.addEventListener('message', listener)
    })

    this.send(type, data, id)

    const resp = await promise

    if (resp.code !== 200) {
      throw new Error(`Code ${resp.code}: ${resp.message}`)
    }

    return resp
  }

  async handleMessage (msg) {
    try {
      msg = JSON.parse(msg.data)
    } catch {
      throw new Error('Invalid message')
    }

    switch (msg.type) {
      case 'candidate':
        this.handleCandidate(msg.data)
        return

      case 'offer':
        await this.handleOffer(msg.data)
        return

      case 'answer':
        await this.handleAnswer(msg.data)
        return

      default:
        throw new Error('Unrecognized message type: ' + msg.type)
    }
  }

  handleCandidate ({ candidate, from }) {
    console.log('Got candidate from ' + from)
    const peer = this.peers.get(from)

    if (!peer) {
      throw new Error('Received candidate from unknown peer: ' + from)
    }

    return peer.addIceCandidate(candidate)
  }

  handleOffer ({ offer, pubKey, from }) {
    console.log('Got offer from ' + from)
    return this.createPeerConnection({ name: from, bundle: { offer, pubKey } })
  }

  handleAnswer ({ answer, pubKey, salt, from }) {
    console.log('Got answer from ' + from)
    const peer = this.peers.get(from)

    if (!peer) {
      throw new Error('Received answer from unknown peer: ' + from)
    }

    pubKey = Buffer.from(pubKey, 'base64')
    salt = Buffer.from(salt, 'base64')

    return Promise.all([
      peer.computeSecret({ name: this.name, pubKey, salt }),
      peer.setRemoteDescription(answer)
    ])
  }
}

module.exports = Client
