'use strict'

const crypto = require('crypto')
const { promisify } = require('util')

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
]

const randBytes = promisify(crypto.randomBytes)

const hmac = ({ data, key }) => {
  const hmac = crypto.createHmac('sha256', key)

  hmac.update(data)

  return hmac.digest()
}

const hkdf = ({ ikm, info, length, salt }) => {
  const key = hmac({ data: ikm, key: salt })

  let t = Buffer.alloc(0)
  let okm = Buffer.alloc(0)

  for (let i = 0; i < Math.ceil(length / 32); i++) {
    const data = Buffer.concat([t, info, Buffer.from([1 + i])])
    t = hmac({ data, key })
    okm = Buffer.concat([okm, t])
  }

  return okm.slice(0, length)
}

class Peer {
  constructor ({ client, name, worker }) {
    const conn = this.conn = new RTCPeerConnection({
      encodedInsertableStreams: true,
      iceServers
    })

    conn.onicecandidate = this.onicecandidate.bind(this)
    conn.ontrack = this.ontrack.bind(this)

    this.candidates = []
    this.client = client
    this.dh = crypto.getDiffieHellman('modp14')
    this.dh.generateKeys()
    this.name = name
    this.pubKey = this.dh.getPublicKey('base64')
    this.secret = null
    this.senders = []
    this.stream = null
    this.trackEvents = []
    this.worker = worker
  }

  async createOffer () {
    const offer = await this.conn.createOffer()

    await this.conn.setLocalDescription(offer)

    return offer
  }

  async createAnswer () {
    const answer = await this.conn.createAnswer()

    await this.conn.setLocalDescription(answer)

    return answer
  }

  async addIceCandidate (candidate) {
    if (!this.conn.remoteDescription) {
      this.candidates.push(candidate)
      return
    }

    await this.conn.addIceCandidate(candidate)
  }

  async setRemoteDescription (desc) {
    await this.conn.setRemoteDescription(desc)

    const promises = this.candidates.map(candidate => this.conn.addIceCandidate(candidate))

    await Promise.all(promises)

    this.candidates = []
  }

  async computeSecret ({ pubKey, name, salt }) {
    const ikm = this.dh.computeSecret(pubKey)
    const info = Buffer.from([this.name, name].sort().join(','))
    salt = salt || await randBytes(32)

    this.secret = hkdf({ ikm, info, length: 32, salt })

    this.senders.forEach(sender => {
      const { readableStream, writableStream } = sender.createEncodedStreams()

      this.worker.postMessage({
        operation: 'encrypt',
        secret: this.secret,
        readableStream,
        writableStream
      }, [readableStream, writableStream])
    })

    this.trackEvents.forEach(this.ontrack.bind(this))

    this.senders = []
    this.trackEvents = []

    return salt
  }

  addTrack (track, stream) {
    const sender = this.conn.addTrack(track, stream)

    this.senders.push(sender)
  }

  // Listeners

  onicecandidate (event) {
    const { candidate } = event

    if (!candidate) return

    this.client.send('candidate', { candidate, to: this.name })
  }

  ontrack (event) {
    if (!this.secret) {
      this.trackEvents.push(event)
      return
    }

    const { readableStream, writableStream } = event.receiver.createEncodedStreams()

    this.worker.postMessage({
      operation: 'decrypt',
      secret: this.secret,
      readableStream,
      writableStream
    }, [readableStream, writableStream])

    this.client.emit('stream', {
      kind: event.track.kind,
      name: this.name,
      stream: event.streams[0]
    })
  }
}

module.exports = Peer
