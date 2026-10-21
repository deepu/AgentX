from build_lib import *
W = {}
# Playbook
msgs = [me('Also copy the CRA on the second reminder'),
  ai(chip('Drafted a change: <strong>step 4</strong>'), p('Drafted: from the second reminder on, the email is copied to the site\'s CRA. The live playbook keeps working as it is until this is approved.'), p('Want a test run on site 104? It only drafts the emails; nothing is sent.')),
  me('Yes'),
  ai(tools('Test run on site 104'), p('Test run done: the second reminder would go to the coordinator with Priya Shah copied. Press <strong>Send for review</strong> when you\'re happy.'))]
banner = '<div style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: #F5F1FF; border: 1px solid #DCD0FA; font-size: 13.5px;"><span style="flex: 1 1 auto;"><strong>Draft from chat:</strong> 1 change · test run passed</span>' + btn('Discard', '#') + btn('Send for review', 'Waiting.dc.html', True) + '</div>'
steps = table('28px 1fr 90px', ['', 'Step', 'Who'], [
  ['1', 'Find the missing documents for the site', 'System'],
  ['2', 'Draft the reminder email', 'Agent'],
  ['3', 'Approve the email', 'You'],
  {'cells': ['4', 'Send, wait 5 days, remind again <span style="color: #43239E; background: #EFEAFD; padding: 0 4px; border-radius: 3px;">and copy the CRA from the second reminder</span>', 'System'], 'style': ' background: #FBF9FF;'},
  ['5', 'Escalate to the CRA if still missing after 3 reminders', 'Agent'],
], '13.5px')
runs = table('1fr 140px 120px', ['This week\'s runs', 'Where', 'Status'], [
  {'href': 'Run.dc.html', 'cells': ['Site 104', 'Step 3 · approve', '<span style="color: #8A4B00;">Waiting for you</span>']},
  {'cells': ['Site 109', 'Step 4 · waiting', '<span style="color: #52525B;">Waiting for site</span>']},
  {'cells': ['Site 102', 'Done', '<span style="color: #1B6B3A;">All uploaded</span>']}])
inner = title('Chase missing documents', pill('Live · version 2', 'green') + '  Reminds sites about documents they still owe') + banner + \
  section(h3('Starts when'), '<span style="font-size: 14px;">Every Friday at 09:00, for each site with missing documents</span>') + \
  section(h3('Steps'), steps) + section('', runs) + \
  '<span style="font-size: 12.5px; color: #6B6B72;">From the Phase 3 study template, version 4 · this project changed it: wait 5 days instead of 3.</span>'
W['Playbook'] = app('A playbook', 'active="p-chase" project="mw301"', chat('Chase missing documents', msgs, 'Ask about this playbook, or ask to change it', 'playbook', (), 'q9'), main('Playbooks  ›  Chase missing documents', inner, '6px 28px 20px'))

# Run
msgs = [me('Make it shorter, and mention the visit on 28 Oct'),
  ai(chip('Changed the email'), p('Done. It\'s four lines now and asks for the documents by Mon 26 Oct, two days before the visit.')),
  me('Who sees it?'),
  ai(p('Only the site coordinator. Priya is copied from the second reminder on, once that change is approved.'))]
email = '''<div style="border: 1px solid #E5E5EA; border-radius: 10px; font-size: 13.5px; box-shadow: inset 3px 0 0 #9C86E8;">
  <div style="padding: 9px 14px; border-bottom: 1px solid #F0F0F2; display: flex; flex-direction: column; gap: 2px; color: #52525B;"><span>To: [Name], site coordinator, site 104</span><span>Subject: <span style="color: #1C1C1E;">MW-301: 4 documents needed before the 28 Oct visit</span></span></div>
  <div style="padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; line-height: 1.5;"><span>Hello [Name],</span><span>Before Priya's visit on Wed 28 Oct we still need the protocol signature page, two CVs and the current lab normal ranges.</span><span>Could you upload them by Mon 26 Oct? The link below needs no login.</span><span style="color: #5B34C9;">[Upload link]</span></div>
  <div style="padding: 6px 14px 9px; font-size: 12px; color: #6E47D1;">Changed from chat · <a href="#">Undo</a></div>
</div>'''
actions = '<div style="display: flex; gap: 8px;">' + btn('Edit', '#') + btn('Approve and send', 'Waiting.dc.html', True) + '</div>'
tl = '<section style="display: flex; flex-direction: column;">' + \
  step(1, 'Find the missing documents', 'System · Fri 09:00', '4 missing: protocol signature page, 2 CVs, lab normal ranges') + \
  step(2, 'Draft the reminder email', 'Agent · Fri 09:01', 'Third reminder for the lab ranges, second for the others') + \
  step(3, 'Approve the email', 'You · waiting since Fri', '', 'wait', email + actions) + \
  step(4, 'Send, wait 5 days, remind again', 'System', '', 'todo') + \
  '<div style="display: grid; grid-template-columns: 22px 1fr; gap: 12px;"><span style="display: flex; justify-content: center;"><span style="width: 18px; height: 18px; border-radius: 50%; border: 2px solid #D4D4D8; box-sizing: border-box;"></span></span><span style="font-size: 14px; color: #6B6B72;">5 · Escalate to the CRA if still missing · Agent</span></div></section>'
inner = title('Chase missing documents, site 104', pill('Waiting for you · step 3', 'orange') + '  Started Fri 16 Oct 09:00 by the schedule · version 2') + tl
W['Run'] = app('A run', 'active="p-chase" project="mw301"', chat('Run · site 104', msgs, 'Ask about this run', 'run', (), 'q10'), main('<a href="Playbook.dc.html" style="color: #52525B;">Chase missing documents</a>  ›  Runs  ›  Site 104, Fri 16 Oct', inner, '6px 28px 20px'))

# Upload on a phone (site contact, no account)
def doc(t, state, note=''):
    if state == 'up':
        r = '<a href="#" style="flex: 0 0 auto; padding: 10px 14px; border-radius: 10px; background: #1C1C1E; color: #FFFFFF; text-decoration: none; font-size: 14px; font-weight: 500;">Upload</a>'
    elif state == 'ok':
        r = '<span style="flex: 0 0 auto; color: #1B6B3A; font-size: 14px; font-weight: 600;">✓ Received</span>'
    else:
        r = '<span style="flex: 0 0 auto; color: #52525B; font-size: 14px;">Checking…</span>'
    n = f'<span style="font-size: 13px; color: {"#1B6B3A" if state == "ok" else "#52525B"};">{note}</span>' if note else ''
    return f'<div style="display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid #F0F0F2;"><span style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px;"><span style="font-size: 15.5px; font-weight: 500;">{t}</span>{n}</span>{r}</div>'
phone = f'''<div style="width: 390px; height: 844px; box-sizing: border-box; background: #FFFFFF; font-family: {FONT}; color: #1C1C1E; padding: 28px 22px 24px; display: flex; flex-direction: column; gap: 18px;">
  <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #52525B;"><span style="font-weight: 800; color: #6E47D1; font-size: 16px;">M</span><span>Study MW-301 · Site 104</span></div>
  <div style="display: flex; flex-direction: column; gap: 6px;"><h1 style="margin: 0; font-size: 26px; font-weight: 600; line-height: 1.2;">4 documents needed</h1><span style="font-size: 15px; color: #52525B; line-height: 1.45;">For the monitoring visit on Wed 28 Oct. Please upload by Mon 26 Oct. No account needed.</span></div>
  <div style="display: flex; flex-direction: column;">
    {doc('Protocol signature page', 'up', 'Signed by the PI, protocol version 3.0')}
    {doc('CV, Dr [Name]', 'ok', 'Looks right: signed and dated 2 Oct 2026')}
    {doc('CV, [Name]', 'check', 'Uploaded just now')}
    {doc('Lab normal ranges', 'up', 'The current ranges from your lab')}
  </div>
  <span style="font-size: 14px; color: #52525B; line-height: 1.45;">Questions? Reply to the reminder email, or ask Priya Shah, your CRA.</span>
  <span style="margin-top: auto; font-size: 12.5px; color: #6B6B72;">Secure link for site 104 · expires 4 Nov</span>
</div>'''
W['Upload'] = page('Site upload link', phone, 390, 844)

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
