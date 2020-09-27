<template>
  <p v-if="error">{{ error.message }}</p>
  <div v-if="joined">
    <h1> Welcome to chat {{ chatId }}, {{ name }}!</h1>
    <div v-if="stream">
      <label>me</label>
      <video :srcObject="stream" autoplay></video>
    </div>
    <div v-for="(peer, name) in peers" :key="name">
      <label>{{ name }}</label>
      <audio v-if="peer.audioStream" :srcObject="peer.audioStream" autoplay></audio>
      <video v-if="peer.videoStream" :srcObject="peer.videoStream" autoplay></video>
    </div>
  </div>
  <div v-else>
    <select v-model="action">
      <option value="join" selected>join chat</option>
      <option value="start">start chat</option>
    </select>
    <form v-on:submit.prevent="handleSubmit">
      <h1>{{ action + ' a chat' }}</h1>
      <input type="text" v-model="chatId" placeholder="Chat ID" v-if="action === 'join'" />
      <input type="text" v-model="name" placeholder="Name" />
      <input type="password" v-model="password" placeholder="Password" />
      <input type="submit" :value="action" />
    </form>
  </div>
</template>

<script>
import Worker from 'worker-loader!../lib/worker'
import Client from '../lib/client'

let client

export default {
  name: 'App',

  data () {
    return {
      action: 'join',
      chatId: '',
      error: null,
      joined: false,
      name: '',
      password: '',
      peers: {},
      stream: null
    }
  },

  methods: {
    async handleSubmit () {
      this.error = null

      if (this.action === 'join' && !this.chatId) {
        this.error = new Error('Please enter chat ID')
        return
      }

      if (!this.name) {
        this.error = new Error('Please enter your name')
        return
      }

      if (!this.password) {
        this.error = new Error('Please enter a password')
        return
      }

      client = new Client(Worker)

      client.on('stream', ({ kind, name, stream }) => {
        const peer = this.peers[name] = this.peers[name] || {}

        if (kind === 'audio') {
          peer.audioStream = stream
        } else {
          peer.videoStream = stream
        }
      })

      try {
        if (this.action === 'join') {
          await client.joinChat({
            host: 'localhost',
            port: 8901,
            chatId: this.chatId,
            name: this.name,
            password: this.password
          })
        } else {
          this.chatId = await client.startChat({
            host: 'localhost',
            port: 8901,
            name: this.name,
            password: this.password
          })
        }
      } catch (err) {
        this.error = err
        return
      }

      this.joined = true
      this.audioStream = client.audioStream
      this.videoStream = client.videoStream
    }
  }
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
</style>
