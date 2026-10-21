from build_lib import *
W = {}
AV = '<span style="display: inline-flex;">' + ''.join(f'<span style="width: 26px; height: 26px; border-radius: 50%; background: {bg}; border: 2px solid #FFFFFF; margin-left: {ml}; font-size: 10.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;">{t}</span>' for t, bg, ml in [('AR', '#E6E6EA', '0'), ('PS', '#DCE8F5', '-8px'), ('TO', '#F6E3CF', '-8px'), ('+3', '#F4F4F6', '-8px')]) + '</span>'

# Home
left = f'''    <section aria-label="Chat" style="width: 488px; flex: 0 0 488px; box-sizing: border-box; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; display: flex; flex-direction: column; padding: 0 32px;">
      <div style="flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 22px;">
        <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 30px; text-align: center;">What do you want to know about Study MW-301?</h1>
        <form style="display: flex; flex-direction: column;">
          <label for="ask" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);">Your question</label>
          <div style="border: 1.5px solid #9C86E8; border-radius: 16px; padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 18px;">
            <textarea id="ask" rows="2" placeholder="Ask about this study's sites, documents or papers" style="border: 0; outline: none; resize: none; font: inherit; font-size: 16px; color: #1C1C1E; background: transparent;"></textarea>
            <div style="display: flex; align-items: center; gap: 8px; color: #52525B; font-size: 14px;">
              <span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">Study TMF</span><span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">PubMed</span>
              <span style="flex: 1 1 auto;"></span><span>Sonnet 5.5 ⌄</span>
              <a href="Ask.dc.html" aria-label="Ask" style="width: 32px; height: 32px; border-radius: 50%; background: #1C1C1E; color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; text-decoration: none;">{SEND}</a>
            </div>
          </div>
        </form>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: #52525B;">Try asking</span>
          <a href="Ask.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">Is site 104 ready for its monitoring visit on 28 Oct?</a>
          <a href="Ask.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">Which documents expire in the next 30 days?</a>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <span style="font-size: 13px; font-weight: 600; color: #52525B;">Recent chats, each with its page</span>
          <a href="Ask.dc.html" style="display: flex; justify-content: space-between; padding: 8px 2px; color: #1C1C1E; text-decoration: none; font-size: 14px; border-bottom: 1px solid #F0F0F2;"><span>Site 104 visit readiness</span><span style="color: #6B6B72;">Page · 1h</span></a>
          <a href="TmfBoard.dc.html" style="display: flex; justify-content: space-between; padding: 8px 2px; color: #1C1C1E; text-decoration: none; font-size: 14px;"><span>TMF gaps by zone</span><span style="color: #6B6B72;">Page · yesterday</span></a>
        </div>
      </div>
    </section>'''
inner = title('Study MW-301', 'Phase 3 · 12 sites · from the Phase 3 study template', AV) + \
  section(h3('Waiting for you', 3), '<div style="display: flex; flex-direction: column; gap: 8px;">' +
    waitrow('Sign the monitoring visit report', 'Site 101 · visit on 14 Oct · written by Priya Shah', 'From Review a visit report', 'Sign.dc.html') +
    waitrow('Approve a reminder email', 'Site 104 · 4 documents missing', 'From Chase missing documents', 'Run.dc.html') +
    waitrow('Review a page change', 'Safety literature · 2 new papers', 'From the page\'s Monday refresh', 'Waiting.dc.html') + '</div>') + \
  section(h3('Documents in place, by site'), bars([('Site 101', 94), ('Site 102', 88), ('Site 104', 61), ('Site 109', 78)]) + '<a href="TmfBoard.dc.html" style="font-size: 13px;">Open TMF by site</a>') + \
  section(h3('Running now'), '<div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 8px; font-size: 13.5px;"><div style="display: flex; justify-content: space-between; gap: 10px;"><span><a href="Playbook.dc.html">File a document</a> · Ethics approval letter, site 109</span><span style="color: #52525B;">AI checking</span></div><div style="height: 6px; border-radius: 3px; background: #EDEDF1;"><div style="width: 55%; height: 6px; border-radius: 3px; background: #6E47D1;"></div></div></div>')
W['Main'] = app('Study home', 'active="home" project="mw301"', left, main('Home  ›  Pinned page', inner, '4px 28px 20px'))
def sw_head(mark, color, name):
    return f'<div style="display: flex; align-items: center; gap: 8px; padding: 10px 10px 4px; font-size: 12.5px; font-weight: 600; color: #52525B;"><span style="width: 18px; height: 18px; border-radius: 5px; background: {color}; color: #FFFFFF; font-size: 8px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; letter-spacing: 0;">{mark}</span>{name}</div>'
def sw_row(label, href, count='', current=False, sub=''):
    bg = ' background: #F1EEFB;' if current else ''
    tick = '<span style="color: #6E47D1; font-weight: 700;">✓</span>' if current else '<span style="width: 10px;"></span>'
    c = f'<span style="font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 999px; background: #E6E6EA; color: #3F3F46;">{count}</span>' if count == 'Draft' else (f'<span style="min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 10px; background: #6E47D1; color: #FFFFFF; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;">{count}</span>' if count else '')
    s = f'<span style="font-size: 12px; color: #6B6B72;">{sub}</span>' if sub else ''
    return f'<a href="{href}" style="display: flex; align-items: center; gap: 10px; padding: 7px 10px 7px 12px; border-radius: 8px; color: #1C1C1E; text-decoration: none; font-size: 14px;{bg}">{tick}<span style="flex: 1 1 auto; display: flex; flex-direction: column;"><span>{label}</span>{s}</span>{c}</a>'
menu = '<div role="menu" aria-label="Switch project" style="position: absolute; left: 10px; top: 98px; width: 320px; box-sizing: border-box; background: #FFFFFF; border: 1px solid #E0E0E5; border-radius: 12px; box-shadow: 0 12px 32px rgba(20, 20, 40, 0.16); padding: 8px; display: flex; flex-direction: column; gap: 1px; font-family: inherit;">' + \
  '<div style="border: 1px solid #E0E0E5; border-radius: 8px; padding: 7px 10px; font-size: 14px; color: #8A8A92; margin-bottom: 4px;">Find a project</div>' + \
  sw_row('<strong>Waiting for you, all projects</strong>', 'XWaitingAll.dc.html', '18') + \
  '<div style="height: 1px; background: #F0F0F2; margin: 6px 0 2px;"></div>' + \
  sw_head('TMF', '#2F6FAE', 'eTMF') + \
  sw_row('Study MW-301', 'Main.dc.html', '3', True) + sw_row('Study MW-207', '#', '5') + sw_row('Study MW-310', 'NewProject.dc.html', 'Draft') + \
  sw_row('<span style="color: #5B34C9;">All studies</span>', 'EPortfolio.dc.html') + \
  sw_head('EDC', '#2C7A7B', 'EDC · Medidata Rave') + \
  sw_row('Study MW-301', 'XEdcHome.dc.html', '8', sub='Same study as eTMF MW-301') + \
  sw_head('Lit', '#B4532A', 'Literature') + \
  sw_row('Literature search', 'LHome.dc.html', '2') + \
  '<div style="height: 1px; background: #F0F0F2; margin: 6px 0 2px;"></div>' + \
  '<div style="display: flex; gap: 8px; padding: 4px 4px 2px;">' + btn('+ New project', 'NewProject.dc.html') + btn('+ Add an app', '#') + '</div></div>'
W['XSwitch'] = app('Switch project', 'active="home" project="mw301"', left, main('Home  ›  Pinned page', inner, '4px 28px 20px'), menu)


# Ask
msgs = [me('Is site 104 ready for its monitoring visit on 28 Oct?'),
  ai(tools('Read site 104\'s records: 38 documents, 4 staff', 'Checked them against the visit checklist'),
     p('<strong>Not yet: 4 of 12 checklist items are open.</strong> The protocol signature page and two CVs are missing, and the lab normal ranges expired on 2 Sep.'),
     p('Chase missing documents emails the site on Friday, five days before the visit. A reminder for this week is waiting for your approval.'),
     p('I\'ve built a page for this on the right. Should it keep watching, every day until the visit?'))]
right_btn = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">' + btn('Keep watching, daily until 28 Oct', 'Main.dc.html', True) + '<span style="font-size: 12px; color: #52525B;">Attaches <a href="Playbook.dc.html">Check site readiness</a></span></span>'
check = table('1fr 120px 70px', ['Checklist item', 'Status', 'From'], [
  ['Protocol signature page', '<span style="color: #8A4B00; font-weight: 500;">Missing</span>', 'Site'],
  ['CV, Dr [Name] (sub-investigator)', '<span style="color: #8A4B00; font-weight: 500;">Missing</span>', 'Site'],
  ['CV, [Name] (coordinator)', '<span style="color: #8A4B00; font-weight: 500;">Missing</span>', 'Site'],
  ['Lab normal ranges', '<span style="color: #8A4B00; font-weight: 500;">Expired 2 Sep</span>', 'Site'],
  ['Delegation log', '<span style="color: #1B6B3A;">Filed</span>', 'Site'],
  ['<span style="color: #52525B;">7 more</span>', '<span style="color: #1B6B3A;">Filed</span>', '']])
inner = title('Site 104 visit readiness', pill('Draft page') + '  Built for your question · reads Site 104 and its documents', right_btn) + \
  p('<span style="font-size: 15px;">Site 104 is <strong>not ready yet</strong>: 4 of 12 items are open, all waiting on the site.</span>') + \
  tiles([('Ready', '8 of 12', 'checklist items'), ('Open', '4', 'all with the site'), ('Visit', '28 Oct', 'in 7 days')]) + \
  section(h3('Checklist'), check)
W['Ask'] = app('Ask and get a page', 'active="b-ready" draft="true" project="mw301"',
  chat('Site 104 visit readiness', msgs, 'Ask about this page, or ask to change it', 'page', ('Study TMF',), 'q1'),
  main('Pages  ›  Site 104 visit readiness', inner))

# Waiting
msgs = [me('What needs me today?'),
  ai(p('Three things:'), ul('<strong>Sign Priya\'s visit report</strong> for site 101. Reports should be signed within 10 working days of the visit, so this is due Wed 28 Oct.', '<strong>Approve a reminder</strong> to site 104 for 4 missing documents. It\'s been waiting since Friday, and the visit is next week.', '<strong>Review a change</strong> to the Safety literature page: 2 new papers, nothing flagged.'),
     p('I\'d do the reminder first: it\'s quick and the site needs time.'), btn('Open the reminder', 'Run.dc.html'))]
inner = title('Waiting for you <span style="color: #6B6B72; font-weight: 400;">3</span>', 'A built-in page: every step, from any playbook in this project, that needs you.') + \
  '<div style="display: flex; flex-direction: column; gap: 10px;">' + \
    waitrow('Approve a reminder email', 'Site 104 · 4 documents missing · visit on 28 Oct', 'From <span style="color: #5B34C9;">Chase missing documents</span>, step 3 · waiting since Fri', 'Run.dc.html', True, 'Waiting 5 days') + \
    waitrow('Sign the monitoring visit report', 'Site 101 · visit on 14 Oct · 2 findings', 'From <span style="color: #5B34C9;">Review a visit report</span>, step 3 · due Wed 28 Oct', 'Sign.dc.html') + \
    waitrow('Review a page change', 'Safety literature · 2 new papers · nothing flagged', 'From the page\'s Monday refresh', 'Waiting.dc.html') + '</div>' + \
  section(h3('Done this week', 3), table('1fr 60px', None, [['<span style="color: #52525B;">Approved for filing · protocol signature page, site 101</span>', '<span style="color: #52525B;">Mon</span>'], ['<span style="color: #52525B;">Approved a playbook change · Chase missing documents</span>', '<span style="color: #52525B;">Mon</span>'], ['<span style="color: #52525B;">Reviewed a page change · Safety literature</span>', '<span style="color: #52525B;">Mon</span>']]))
W['Waiting'] = app('Waiting for you', 'active="waiting" project="mw301"', chat('Waiting for you', msgs, 'Ask about what\'s waiting', 'page', (), 'q2'), main('Waiting for you', inner))

# Sign
msgs = [me('Anything I should push back on?'),
  ai(p('One thing. <strong>Action 2</strong> (replace the faulty temperature logger) has no due date.'), p('Everything else checks out: the visit date, who attended, and both findings have an action.'), p('Send it back to Priya with that note, or sign as it is?'), btn('Send back with this note', 'Waiting.dc.html'))]
checks = '<div style="display: flex; flex-direction: column; gap: 6px; font-size: 13.5px;"><span><span style="color: #1B6B3A; font-weight: 600;">✓</span> All required sections are there · <a href="#">Show</a></span><span><span style="color: #1B6B3A; font-weight: 600;">✓</span> Attendees match the site staff list · <a href="#">Show</a></span><span><span style="color: #8A4B00; font-weight: 600;">!</span> Action 2 has no due date · <a href="#">Show quote</a></span></div>'
findings = table('24px 1fr 60px 140px 70px', ['', 'Finding', 'Grade', 'Action', 'Due'], [
  ['1', 'Temperature log missing for 2 days', 'Minor', 'Retrain coordinator', '4 Nov'],
  ['2', 'Temperature logger faulty', 'Minor', 'Replace the logger', '<span style="color: #8A4B00; font-weight: 500;">None</span>']], '13px')
sig = '''<div style="margin-top: auto; border: 1px solid #E5E5EA; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
  <span style="font-size: 14px; font-weight: 600;">Your signature</span>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px;">
    <label style="display: flex; flex-direction: column; gap: 4px; color: #52525B;">Meaning<select style="font: inherit; font-size: 14px; padding: 7px 9px; border: 1px solid #D4D4D8; border-radius: 8px; background: #FFFFFF; color: #1C1C1E;"><option>Reviewed and approved</option></select></label>
    <label style="display: flex; flex-direction: column; gap: 4px; color: #52525B;">Password<input type="password" value="........" style="font: inherit; font-size: 14px; padding: 7px 9px; border: 1px solid #D4D4D8; border-radius: 8px;"></label>
  </div>
  <div style="display: flex; align-items: center; gap: 10px;"><span style="flex: 1 1 auto; font-size: 12.5px; color: #52525B;">Signing records your name, the time and this meaning, and locks this version.</span>''' + btn('Send back', 'Waiting.dc.html') + btn('Sign', 'Waiting.dc.html', True) + '</div></div>'
inner = title('Monitoring visit report, site 101', 'Visit on 14 Oct · written by Priya Shah (CRA) · from <a href="Playbook.dc.html">Review a visit report</a>, step 3') + \
  section(h3('What the AI checked'), checks) + section(h3('Findings', 2), findings + '<a href="#" style="font-size: 13px;">Open the full report (PDF, 6 pages)</a>') + sig
W['Sign'] = app('Sign a report', 'active="waiting" project="mw301"', chat('Monitoring visit report', msgs, 'Ask about this report', 'report', (), 'q3'), main('Waiting for you  ›  Sign the monitoring visit report', inner, '6px 28px 20px'))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
