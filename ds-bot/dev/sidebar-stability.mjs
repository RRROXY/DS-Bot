import assert from 'node:assert/strict'

// Run against an isolated mock bench. A section's contents must not change the
// header's width, or scroll the Main Bot along with the conversation list.
export async function checkSidebarStability(page, { heights } = {}) {
  const viewport = page.viewportSize()
  const headings = page.locator('.bt-section-heading')
  const expanded = await headings.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded') === 'true'))
  assert.ok(expanded.length > 0, 'the fixture needs a sidebar section')
  const list = page.locator('.bt-side:not(.bt-rail) > .bt-list')
  const scrollTop = await list.evaluate(node => node.scrollTop)
  const anchors = () => page.evaluate(() => [...document.querySelectorAll('.bt-side-top > .bt-round, .bt-tile')].map(node => {
    const rect = node.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  const observations = []
  try {
    for (const height of viewport ? heights ?? [viewport.height, Math.min(viewport.height, 440)] : [null]) {
      if (viewport) await page.setViewportSize({ ...viewport, height })
      await page.waitForTimeout(500)
      const before = await anchors()
      assert.ok(before.length >= 4, 'Main Bot and the three header buttons are visible')
      const unchanged = async label => {
        const after = await anchors()
        assert.equal(after.length, before.length)
        for (let i = 0; i < before.length; i++) {
          for (const key of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[i][key] - after[i][key]) < 0.5, `${label}: anchor ${i} ${key} moved from ${before[i][key]} to ${after[i][key]}`)
          }
        }
      }
      for (const open of [false, true, false, true]) {
        for (let i = 0; i < expanded.length; i++) {
          const button = headings.nth(i)
          if ((await button.getAttribute('aria-expanded') === 'true') !== open) await button.click()
          await page.waitForTimeout(100)
          await unchanged(`height ${height}, section ${i}, open ${open}`)
        }
        const dimensions = await list.evaluate(node => {
          node.scrollTop = node.scrollHeight
          return { scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
        })
        await unchanged(`height ${height}, list scroll`)
        observations.push({ height, open, ...dimensions })
      }
    }
  } finally {
    if (viewport) await page.setViewportSize(viewport)
    for (let i = 0; i < expanded.length; i++) {
      const button = headings.nth(i)
      if ((await button.getAttribute('aria-expanded') === 'true') !== expanded[i]) await button.click()
    }
    await list.evaluate((node, top) => { node.scrollTop = top }, scrollTop)
  }
  return observations
}
