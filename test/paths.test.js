import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePathCandidate, parsePaths, isLoopbackAddress } from '../paths.js'

test('normalizePathCandidate trims and handles quotes', () => {
  assert.equal(normalizePathCandidate('  "/Users/jkw/test.mp4"  '), '/Users/jkw/test.mp4')
  assert.equal(normalizePathCandidate("'/Users/jkw/folder'"), '/Users/jkw/folder')
})

test('normalizePathCandidate handles file:// URLs', () => {
  assert.equal(normalizePathCandidate('file:///Users/jkw/test%20file.txt'), '/Users/jkw/test file.txt')
  assert.equal(normalizePathCandidate('file://localhost/Users/jkw/test.txt'), '/Users/jkw/test.txt')
})

test('parsePaths parses multi-line paths and ignores empty/comment lines', () => {
  const input = `
/Users/jkw/file1.mov
# comment
/Users/jkw/file2.mp4

/Users/jkw/file1.mov
`
  const result = parsePaths(input)
  assert.deepEqual(result, ['/Users/jkw/file1.mov', '/Users/jkw/file2.mp4'])
})

test('isLoopbackAddress identifies 127.0.0.1 and ::1', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.100'), false)
})
