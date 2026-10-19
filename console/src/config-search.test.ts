import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigCenter, CONFIG_FIELD_EFFECT, patchHasCold, validateConfigPatch } from './config.ts'

test('web search validates provider input and is a hot field', () => {
  const webSearch = { apiKey: '', apiKeyEnv: 'SEARCH_KEY', baseURL: 'https://search.example/anthropic/v1', model: 'search-model', maxTokens: 1024, maxUses: 2 }
  assert.deepEqual(validateConfigPatch({ webSearch }), { webSearch })
  assert.equal(CONFIG_FIELD_EFFECT.webSearch, 'hot')
  assert.equal(patchHasCold({ webSearch }), false)
  for (const bad of [[], 'bad', { unknown: true }, { apiKey: 1 }, { apiKeyEnv: 'bad-ref' }, { baseURL: 'file:///tmp' }, { baseURL: 'https://user:password@host/' }, { baseURL: 'https://host/?key=secret' }, { model: '' }, { maxTokens: 0 }, { maxUses: 1.5 }]) {
    assert.throws(() => validateConfigPatch({ webSearch: bad }))
  }
})

test('search inheritance, restoration and returned copies preserve the public config', () => {
  const center = new ConfigCenter({ revision: 0, public: { webSearch: { apiKeyEnv: 'SHARED_SEARCH', baseURL: 'https://search.example/v1', model: 'public-search', maxUses: 5 } }, assistants: {}, skillLibrary: {} })
  const patch = { webSearch: { model: 'private-search' } }
  center.updateAssistant('one', patch)
  patch.webSearch.model = 'mutated'
  assert.equal(center.resolve('one').webSearch?.model, 'private-search')
  assert.equal(center.resolve('one').webSearch?.baseURL, 'https://search.example/v1')
  assert.equal(center.resolve('two').webSearch?.model, 'public-search')
  center.resolve('one').webSearch!.maxUses = 99
  assert.equal(center.resolve('one').webSearch?.maxUses, 5)
  center.updateAssistant('one', validateConfigPatch({ webSearch: null }))
  assert.equal(center.resolve('one').webSearch?.model, 'public-search')
  center.updatePublic(validateConfigPatch({ webSearch: null }))
  assert.equal(center.resolve('one').webSearch, undefined)
})
