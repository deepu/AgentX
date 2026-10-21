FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif"
SEND = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>'
PEN = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6E47D1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>'

def page(title, body, w=1440, h=900):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{{margin:0}}
a{{color:#5B34C9}}a:hover{{color:#43239E}}
</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''

def app(title, sidebar, left, main, overlay=''):
    body = f'''<div style="position: relative; width: 1440px; height: 900px; box-sizing: border-box; background: #F4F4F6; font-family: {FONT}; color: #1C1C1E; display: flex; flex-direction: column;">
  <div style="height: 44px; flex: 0 0 44px; display: flex; align-items: center; gap: 16px; padding: 0 18px; font-size: 15px;">
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#52525B" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path></svg>
    <span style="font-weight: 800; color: #6E47D1; font-size: 18px;">M</span>
    <span style="color: #6B6B72;">‹  ›</span>
    <span style="display: inline-flex; align-items: center; gap: 8px; font-weight: 500;"><span style="width: 22px; height: 22px; border-radius: 6px; background: #4F7A3A; color: #FFFFFF; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;">M</span>My Workspace ⌄</span>
    <span style="flex: 1 1 auto;"></span>
    <span style="color: #52525B; font-size: 18px;">+</span>
  </div>
  <div style="flex: 1 1 auto; display: flex; min-height: 0; padding: 0 8px 8px 0; gap: 8px;">
    <dc-import name="Sidebar" {sidebar} hint-size="236px,856px"></dc-import>
{left}
{main}
  </div>
{overlay}
</div>'''
    return page(title, body)

def composer(placeholder, chips=(), id='q'):
    ch = ''.join(f'<span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">{c}</span>' for c in chips)
    return f'''      <div style="padding: 0 20px 18px;">
        <div style="border: 1.5px solid #E0E0E5; border-radius: 14px; padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 12px;">
          <label for="{id}" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);">{placeholder}</label>
          <textarea id="{id}" rows="1" placeholder="{placeholder}" style="border: 0; outline: none; resize: none; font: inherit; font-size: 15px; background: transparent; color: #1C1C1E;"></textarea>
          <div style="display: flex; align-items: center; gap: 8px; color: #52525B; font-size: 13px;">
            {ch}<span style="flex: 1 1 auto;"></span>
            <span>Sonnet 5.5 ⌄</span>
            <span style="width: 30px; height: 30px; border-radius: 50%; background: #D4D4D8; color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center;">{SEND}</span>
          </div>
        </div>
      </div>'''

def chat(title, msgs, placeholder, about='page', chips=(), id='q'):
    return f'''    <section aria-label="Chat" style="width: 488px; flex: 0 0 488px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;">
      <div style="padding: 14px 24px; border-bottom: 1px solid #F0F0F2; display: flex; align-items: center; gap: 8px; font-size: 14px;">
        <span style="font-weight: 600;">{title}</span>
        <span style="flex: 1 1 auto;"></span>
        <span style="color: #6B6B72; font-size: 13px;">Chat about the {about} →</span>
      </div>
      <div style="flex: 1 1 auto; overflow: hidden; padding: 18px 24px; display: flex; flex-direction: column; gap: 16px; font-size: 14.5px; line-height: 1.5;">
{''.join(msgs)}
      </div>
{composer(placeholder, chips, id)}
    </section>'''

def me(t):
    return f'        <div style="align-self: flex-end; max-width: 400px; background: #F4F4F6; border-radius: 14px; padding: 10px 14px;">{t}</div>\n'
def ai(*parts):
    return '        <div style="display: flex; flex-direction: column; gap: 10px;">' + ''.join(parts) + '</div>\n'
def p(t):
    return f'<p style="margin: 0;">{t}</p>'
def ul(*items):
    return '<ul style="margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px;">' + ''.join(f'<li>{i}</li>' for i in items) + '</ul>'
def tools(*lines):
    return '<div style="display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #52525B;">' + ''.join(f'<span>✓ {l}</span>' for l in lines) + '</div>'
def chip(t, undo=True):
    u = ' <a href="#" style="font-weight: 500;">Undo</a>' if undo else ''
    return f'<div style="display: inline-flex; align-self: flex-start; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; background: #F5F1FF; border: 1px solid #DCD0FA; font-size: 13.5px;">{PEN}<span>{t}</span>{u}</div>'
def btn(t, href, primary=False):
    if primary:
        return f'<a href="{href}" style="align-self: flex-start; flex: 0 0 auto; white-space: nowrap; padding: 8px 13px; border-radius: 8px; background: #1C1C1E; color: #FFFFFF; text-decoration: none; font-size: 13.5px; font-weight: 500;">{t}</a>'
    return f'<a href="{href}" style="align-self: flex-start; flex: 0 0 auto; white-space: nowrap; padding: 7px 12px; border-radius: 8px; border: 1px solid #D4D4D8; color: #1C1C1E; text-decoration: none; font-size: 13.5px; background: #FFFFFF;">{t}</a>'

def main(crumb, inner, pad='6px 28px 24px'):
    return f'''    <main style="flex: 1 1 auto; min-width: 0; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;">
      <div style="padding: 16px 28px 4px; font-size: 13px; color: #52525B;">{crumb}</div>
      <div style="padding: {pad}; display: flex; flex-direction: column; gap: 18px; flex: 1 1 auto; min-height: 0;">
{inner}
      </div>
    </main>'''

def title(h, sub='', right=''):
    s = f'<span style="font-size: 13px; color: #52525B;">{sub}</span>' if sub else ''
    return f'<div style="display: flex; align-items: flex-start; gap: 10px;"><div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 5px;"><h2 style="margin: 0; font-size: 23px; font-weight: 600; line-height: 1.25;">{h}</h2>{s}</div>{right}</div>'
def pill(t, kind='grey'):
    c = {'grey': ('#F4F4F6', '#3F3F46'), 'green': ('#E8F3EC', '#1B6B3A'), 'orange': ('#FDF1DF', '#8A4B00'), 'purple': ('#F5F1FF', '#43239E')}[kind]
    return f'<span style="padding: 2px 8px; border-radius: 999px; background: {c[0]}; color: {c[1]}; font-weight: 500; white-space: nowrap;">{t}</span>'
def h3(t, n=''):
    n = f' <span style="color: #6B6B72; font-weight: 400;">{n}</span>' if n != '' else ''
    return f'<h3 style="margin: 0; font-size: 14px; font-weight: 600;">{t}{n}</h3>'
def section(head, body, changed=False):
    if changed:
        return f'<section style="border-left: 3px solid #9C86E8; padding-left: 14px; display: flex; flex-direction: column; gap: 8px;">{head}{body}</section>'
    return f'<section style="display: flex; flex-direction: column; gap: 8px;">{head}{body}</section>'
def changed_head(t):
    return f'<div style="display: flex; align-items: baseline; gap: 10px;">{h3(t)}<span style="font-size: 12px; color: #6E47D1;">Changed from chat · <a href="#">Undo</a></span></div>'

def table(cols, header, rows, size='13.5px'):
    g = f'display: grid; grid-template-columns: {cols}; gap: 10px; padding: 9px 14px;'
    out = f'<div style="border: 1px solid #E5E5EA; border-radius: 10px; font-size: {size};">'
    if header:
        out += f'<div style="{g} font-size: 12px; font-weight: 600; color: #52525B; border-bottom: 1px solid #F0F0F2;">' + ''.join(f'<span>{h}</span>' for h in header) + '</div>'
    for i, r in enumerate(rows):
        href = None; extra = ''
        if isinstance(r, dict):
            href = r.get('href'); extra = r.get('style', ''); r = r['cells']
        border = '' if i == len(rows) - 1 else ' border-bottom: 1px solid #F0F0F2;'
        cells = ''.join(f'<span>{c}</span>' for c in r)
        if href:
            out += f'<a href="{href}" style="{g}{border} color: #1C1C1E; text-decoration: none;{extra}">{cells}</a>'
        else:
            out += f'<div style="{g}{border}{extra}">{cells}</div>'
    return out + '</div>'

def tiles(items):
    out = f'<div style="display: grid; grid-template-columns: repeat({len(items)}, minmax(0, 1fr)); gap: 12px;">'
    for lab, val, sub in items:
        out += f'<div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 2px;"><span style="font-size: 12.5px; color: #52525B;">{lab}</span><span style="font-size: 23px; font-weight: 600; font-variant-numeric: tabular-nums;">{val}</span><span style="font-size: 12px; color: #6B6B72;">{sub}</span></div>'
    return out + '</div>'

def bars(rows, label_w=70):
    out = '<div style="display: flex; flex-direction: column; gap: 7px; font-size: 13px;">'
    for lab, v in rows:
        col = '#C26A00' if v < 80 else '#5B34C9'
        out += f'<div style="display: grid; grid-template-columns: {label_w}px 1fr 44px; align-items: center; gap: 10px;"><span>{lab}</span><span style="height: 10px; border-radius: 3px; background: #EDEDF1;"><span style="display: block; width: {v}%; height: 10px; border-radius: 3px; background: {col};"></span></span><span style="text-align: right; font-variant-numeric: tabular-nums;">{v}%</span></div>'
    return out + '</div>'

def note(t):
    return f'<div style="padding: 12px 14px; border-radius: 10px; background: #F9F9FA; font-size: 13px; color: #52525B; line-height: 1.5;">{t}</div>'

def waitrow(t, sub, src, href, primary=False, flag=''):
    b = f'<span style="padding: 7px 12px; border-radius: 8px; background: #1C1C1E; color: #FFFFFF; font-size: 13px; font-weight: 500;">Open</span>' if primary else '<span style="padding: 7px 12px; border-radius: 8px; border: 1px solid #D4D4D8; font-size: 13px;">Open</span>'
    f = f'<span style="font-size: 12px; color: #8A4B00; font-weight: 500;">{flag}</span>' if flag else ''
    return f'<a href="{href}" style="border: 1px solid #E5E5EA; border-radius: 12px; padding: 13px 16px; display: flex; gap: 14px; align-items: center; color: #1C1C1E; text-decoration: none;"><span style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px;"><span style="font-size: 14.5px; font-weight: 600;">{t}</span><span style="font-size: 13px; color: #52525B;">{sub}</span><span style="font-size: 12.5px; color: #6B6B72;">{src}</span></span><span style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">{f}{b}</span></a>'

def step(n, t, who, detail='', state='done', extra=''):
    dot = {'done': '<span style="width: 18px; height: 18px; border-radius: 50%; background: #1B6B3A; color: #FFFFFF; font-size: 11px; display: inline-flex; align-items: center; justify-content: center;">✓</span>',
           'wait': '<span style="width: 18px; height: 18px; border-radius: 50%; background: #FFFFFF; border: 2px solid #C26A00; box-sizing: border-box;"></span>',
           'todo': '<span style="width: 18px; height: 18px; border-radius: 50%; border: 2px solid #D4D4D8; box-sizing: border-box;"></span>'}[state]
    col = '#6B6B72' if state == 'todo' else '#1C1C1E'
    d = f'<span style="font-size: 13.5px; color: #52525B;">{detail}</span>' if detail else ''
    return f'<div style="display: grid; grid-template-columns: 22px 1fr; gap: 12px;"><span style="display: flex; flex-direction: column; align-items: center;">{dot}<span style="flex: 1 1 auto; width: 2px; background: #E5E5EA;"></span></span><span style="display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; color: {col};"><span style="font-size: 14px; font-weight: {500 if state != "todo" else 400};">{n} · {t} <span style="font-weight: 400; color: #6B6B72;">· {who}</span></span>{d}{extra}</span></div>'
