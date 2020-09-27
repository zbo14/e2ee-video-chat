'use strict'

/* global TransformStream */

const crypto = require('crypto')
const { promisify } = require('util')

const randBytes = promisify(crypto.randomBytes)

const encrypt = ({ key, nonce, plaintext }) => {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ])

  const tag = cipher.getAuthTag()

  return { ciphertext, tag }
}

const decrypt = ({ ciphertext, key, nonce, tag }) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)

  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ])
}

const createSenderTransform = secret => {
  return new TransformStream({
    start () {},
    flush () {},

    async transform (encodedFrame, controller) {
      const plaintext = Buffer.from(encodedFrame.data)
      const nonce = await randBytes(16)
      const { ciphertext, tag } = encrypt({ key: secret, nonce, plaintext })
      const payload = Buffer.concat([nonce, tag, ciphertext])
      encodedFrame.data = payload.buffer
      controller.enqueue(encodedFrame)
    }
  })
}

const createReceiverTransform = secret => {
  return new TransformStream({
    start () {},
    flush () {},

    transform (encodedFrame, controller) {
      const data = Buffer.from(encodedFrame.data)
      const nonce = data.slice(0, 16)
      const tag = data.slice(16, 32)
      const ciphertext = data.slice(32)
      const plaintext = decrypt({ ciphertext, key: secret, nonce, tag })
      encodedFrame.data = plaintext.buffer
      controller.enqueue(encodedFrame)
    }
  })
}

onmessage = event => {
  const transform = event.data.operation === 'encrypt'
    ? createSenderTransform(event.data.secret)
    : createReceiverTransform(event.data.secret)

  event.data.readableStream
    .pipeThrough(transform)
    .pipeTo(event.data.writableStream)
}
