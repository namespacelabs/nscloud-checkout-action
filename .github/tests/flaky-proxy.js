#!/usr/bin/env node
// A simple HTTP proxy that fails the first N CONNECT requests, then proxies normally.
// Used to test retry logic in the checkout action.
//
// Usage: node flaky-proxy.js <port> <fail-count>
// Example: node flaky-proxy.js 8888 2
// This will fail the first 2 CONNECT requests, then proxy normally.

const net = require('net')
const http = require('http')

const port = parseInt(process.argv[2], 10) || 8888
const failCount = parseInt(process.argv[3], 10) || 2

let requestCount = 0

const server = http.createServer((req, res) => {
  // Regular HTTP requests (not used by git over HTTPS, but handle anyway)
  res.writeHead(400)
  res.end('This proxy only supports CONNECT')
})

server.on('connect', (req, clientSocket, head) => {
  requestCount++
  const currentRequest = requestCount
  const [host, portStr] = req.url.split(':')
  const targetPort = parseInt(portStr, 10) || 443

  console.log(`[${currentRequest}] CONNECT ${req.url}`)

  if (currentRequest <= failCount) {
    console.log(`[${currentRequest}] Simulating failure (${currentRequest}/${failCount})`)
    clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    clientSocket.destroy()
    return
  }

  console.log(`[${currentRequest}] Proxying to ${host}:${targetPort}`)

  const serverSocket = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    serverSocket.write(head)
    serverSocket.pipe(clientSocket)
    clientSocket.pipe(serverSocket)
  })

  serverSocket.on('error', err => {
    console.error(`[${currentRequest}] Server socket error: ${err.message}`)
    clientSocket.destroy()
  })

  clientSocket.on('error', err => {
    console.error(`[${currentRequest}] Client socket error: ${err.message}`)
    serverSocket.destroy()
  })
})

server.listen(port, () => {
  console.log(`Flaky proxy listening on port ${port}, will fail first ${failCount} requests`)
})
