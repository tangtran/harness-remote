import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

/** An adapter like Gemini CLI or Kiro CLI: creates and loads Sessions, but has no session/list. */
class NoListAcp {
  calls = []
  sessionCapabilities = {}
  promptCapabilities = {}
  sessionListUnsupported = false
  processID = 4242
  #next = 0
  on() { return this }
  off() { return this }
  async start() {}
  close() {}
  diagnostics() { return { processID: this.processID } }
  notify() {}
  subscribe() { return () => {} }
  async listSessions() {
    this.sessionListUnsupported = true
    return []
  }
  async request(method, params) {
    this.calls.push(method)
    if (method === "session/new") return { sessionId: `native-${++this.#next}` }
    if (method === "session/load") return {}
    return {}
  }
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await check()
    } catch (error) {
      if (attempt === 99) throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

test("Sessions created on an adapter without session/list are listed again after a restart", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-local-index-"))
  try {
    const first = new AcpService(new NoListAcp(), { snapshotDirectory })
    // The Session rail lists first, which is how the bridge learns the adapter cannot enumerate.
    assert.deepEqual(await first.listSessions(), [])
    const created = await first.createSession({ directory: "/repo", title: "Gemini work" })
    await first.createSession({ directory: "/other", title: "Elsewhere" })
    await eventually(() => access(path.join(snapshotDirectory, "local-session-index.json")))

    // A new process: nothing in memory, and the adapter still cannot enumerate its Sessions.
    const acp = new NoListAcp()
    const restarted = new AcpService(acp, { snapshotDirectory })
    const listed = await eventually(async () => {
      const sessions = await restarted.listSessions("/repo")
      assert.equal(sessions.length, 1)
      return sessions
    })
    assert.equal(listed[0].id, created.id)
    assert.equal(listed[0].title, "Gemini work")
    assert.deepEqual((await restarted.localSessionIndex()).map((entry) => entry.cwd).sort(), ["/other", "/repo"])

    // The listed Session is addressable, so reopening it reaches the adapter's session/load.
    await restarted.messagePage(created.id, { limit: 10, refresh: true })
    assert.ok(acp.calls.includes("session/load"))
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})

test("an adapter whose session/list works does not maintain a local index", async () => {
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "harness-local-index-"))
  try {
    const acp = new NoListAcp()
    acp.listSessions = async () => []
    const service = new AcpService(acp, { snapshotDirectory })
    await service.listSessions()
    await service.createSession({ directory: "/repo", title: "Listed natively" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assert.rejects(access(path.join(snapshotDirectory, "local-session-index.json")), { code: "ENOENT" })
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
})
