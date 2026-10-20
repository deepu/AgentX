import { describe, expect, test } from 'bun:test'
import { parseInline, parseMarkdown } from '../markdown'

describe('instructions Markdown', () => {
  test('paragraphs, bold and lists', () => {
    const blocks = parseMarkdown('Please send us your **PAN card** and\nGST certificate.\n\n- A clear photo\n- Both sides\n\n1. Upload\n2. Check')
    expect(blocks).toEqual([
      { kind: 'p', inlines: [{ text: 'Please send us your ' }, { text: 'PAN card', bold: true }, { text: ' and GST certificate.' }] },
      { kind: 'ul', items: [[{ text: 'A clear photo' }], [{ text: 'Both sides' }]] },
      { kind: 'ol', items: [[{ text: 'Upload' }], [{ text: 'Check' }]] },
    ])
  })

  test('HTML stays text: nothing is ever turned into markup', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(blocks).toEqual([{ kind: 'p', inlines: [{ text: '<script>alert(1)</script> <img src=x onerror=alert(1)>' }] }])
  })

  test('links become their words with the address as text; images their description', () => {
    expect(parseInline('See [our checklist](https://acme.example/list) or <https://acme.example>.')).toEqual([
      { text: 'See our checklist (https://acme.example/list) or https://acme.example.' },
    ])
    expect(parseInline('[click me](javascript:alert(1))')).toEqual([{ text: 'click me' }])
    expect(parseInline('[form](https://en.wikipedia.org/wiki/PAN_(India))')).toEqual([{ text: 'form (https://en.wikipedia.org/wiki/PAN_(India))' }])
    expect(parseInline('Write to [us](mailto:help@acme.example)')).toEqual([{ text: 'Write to us (help@acme.example)' }])
    expect(parseInline('![PAN sample](https://evil.example/x.png)')).toEqual([{ text: 'PAN sample' }])
  })

  test('italic, code and escapes', () => {
    expect(parseInline('*only* `PDF` files \\*please\\*')).toEqual([
      { text: 'only', italic: true },
      { text: ' PDF files *please*' },
    ])
  })

  test('snake_case is not emphasis', () => {
    expect(parseInline('the client_name and gst_number fields')).toEqual([{ text: 'the client_name and gst_number fields' }])
  })

  test('headings become bold lines; a list item continues on an indented line', () => {
    expect(parseMarkdown('## What we need\n- Your PAN card,\n  front side')).toEqual([
      { kind: 'h', inlines: [{ text: 'What we need' }] },
      { kind: 'ul', items: [[{ text: 'Your PAN card, front side' }]] },
    ])
  })

  test('empty instructions give nothing', () => {
    expect(parseMarkdown('  \n\n ')).toEqual([])
  })
})
