from build_lib import *
W = {}
SB = 'project="mw301"'

def mute(t):
    return f'<span style="color: #6B6B72;">{t}</span>'
def warn(t):
    return f'<span style="color: #8A4B00; font-weight: 500;">{t}</span>'
def ok(t):
    return f'<span style="color: #1B6B3A;">{t}</span>'
def mark(t):
    return f'<span style="background: #EFEAFD; color: #43239E; padding: 0 3px; border-radius: 3px;">{t}</span>'

# ---------- TMF index: a parent page with one sub-page per zone ----------
msgs = [me('Which zones are behind?'),
  ai(p('Two. <strong>Site management</strong> is missing 14 documents, mostly CVs and lab ranges at sites 104 and 109, and 6 more are waiting for QC.'),
     p('<strong>Approvals</strong> is missing 4 ethics letters. Everything else is complete.'),
     p('One more thing an inspector will ask about: 31 documents were filed more than 30 days after they were final.'))]
zones = [('01', 'Trial management', 142, 0, 0), ('02', 'Central trial documents', 96, 0, 0), ('03', 'Regulatory', 61, 1, 0),
         ('04', 'IRB/IEC and other approvals', 118, 4, 2), ('05', 'Site management', 702, 14, 6), ('06', 'IP and trial supplies', 188, 0, 0),
         ('07', 'Safety reporting', 214, 0, 0), ('08', 'Central and local testing', 97, 1, 0), ('09', 'Third parties', 41, 0, 0),
         ('10', 'Data management', 77, 3, 0), ('11', 'Statistics', 104, 0, 0)]
rows = []
for n, name, exp, miss, qc in zones:
    filed = exp - miss - qc
    rows.append({'cells': [f'{n} · {name}', f'{exp:,}', f'{filed:,}', warn(miss) if miss else mute('0'), (str(qc) if qc else mute('0'))], 'style': ' padding-top: 7px; padding-bottom: 7px;'})
idx = table('1fr 80px 70px 70px 60px', ['Zone (each is a sub-page)', 'Expected', 'Filed', 'Missing', 'In QC'], rows, '13px')
live = '<span style="flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 5px 10px; border-radius: 8px; background: #F5F1FF; color: #43239E; font-weight: 500;">↻ Live</span>'
inner = title('TMF index', 'Built from the TMF Reference Model · expected documents come from the study plan', live) + \
  tiles([('Filed', '1,809', 'of 1,840 expected'), ('Missing', '23', 'all requested'), ('Waiting for QC', '8', 'oldest 4 days'), ('Filed late', '31', 'over 30 days after final')]) + idx
W['EIndex'] = app('TMF index', 'active="b-index" ' + SB, chat('TMF index', msgs, 'Ask about the TMF', 'page', ('Study TMF',), 'e1'), main('Pages  ›  TMF index', inner, '6px 28px 20px'))

# ---------- Inspection readiness: a page built from a question ----------
msgs = [me('The MHRA is inspecting MW-301 on 16 to 18 Nov. Get us ready.'),
  ai(tools('Checked the TMF index against the inspection checklist', 'Read the audit trail for late filings and unsigned versions'),
     p('<strong>Mostly ready. Three things need work:</strong> 23 missing documents, 4 final versions without a signature, and 31 late filings that need a note saying why.'),
     p('I\'ve drafted a plan on the right: gaps fixed by 6 Nov, then a mock inspection on 9 Nov.'),
     p('Keep it and <strong>Get ready for an inspection</strong> runs daily until the 16th. It also sets up the inspectors\' read-only access.'))]
right_btn = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">' + btn('Keep watching, daily until 16 Nov', 'EIndex.dc.html', True) + '<span style="font-size: 12px; color: #52525B;">Attaches Get ready for an inspection</span></span>'
plan = table('1fr 150px 110px 64px', ['Check', 'Now', 'Owner', 'Due'], [
  ['Every expected document filed', warn('23 missing'), 'Tom Okafor', '6 Nov'],
  ['Every final version signed', warn('4 unsigned'), 'Anika Rao', '30 Oct'],
  ['Late filings explained', warn('31 need a note'), 'Tom Okafor', '6 Nov'],
  ['Audit trail export', ok('Ready'), 'System', mute('n/a')],
  ['Inspector access', mute('Not set up'), 'Anika Rao', '13 Nov'],
  ['Mock inspection', mute('Planned'), 'Priya Shah', '9 Nov']], '13.5px')
inner = title('MHRA inspection readiness', pill('Draft page') + '  Built for your question · reads the TMF index and audit trail', right_btn) + \
  p('<span style="font-size: 15px; line-height: 1.5;">The TMF is <strong>98% filed</strong>. Fix the gaps, signatures and late-filing notes by 6 Nov, and rehearse on 9 Nov.</span>') + \
  tiles([('Ready', '1 of 6', 'checks'), ('Days left', '26', 'inspection 16 Nov'), ('Inspectors', '2', 'read-only from 16 Nov')]) + \
  section(h3('Plan'), plan)
W['EInspection'] = app('Inspection readiness', 'active="b-insp" insp="true" ' + SB, chat('MHRA inspection readiness', msgs, 'Ask about this page, or ask to change it', 'page', ('Study TMF',), 'e2'), main('Pages  ›  MHRA inspection readiness', inner, '6px 28px 20px'))

# ---------- The inspector's view: read-only, outside the project ----------
tree_items = [('01 · Trial management', False), ('02 · Central trial documents', False), ('03 · Regulatory', False), ('04 · Approvals', False), ('05 · Site management', True), ('06 · IP and trial supplies', False), ('07 · Safety reporting', False), ('08 · Testing', False), ('09 · Third parties', False), ('10 · Data management', False), ('11 · Statistics', False)]
tree = ''.join(f'<span style="padding: 6px 10px; border-radius: 6px; {"background: #E6E6EA; font-weight: 500;" if on else ""}">{t}</span>' for t, on in tree_items)
docs = table('1fr 80px', None, [
  {'cells': ['<strong>Protocol signature page</strong><br><span style="font-size: 12px; color: #52525B;">Site 101 · v2 · signed 6 Oct</span>', ok('Filed')], 'style': ' background: #F5F1FF;'},
  {'cells': ['Delegation log<br><span style="font-size: 12px; color: #52525B;">Site 101 · v4 · signed 2 Sep</span>', ok('Filed')]},
  {'cells': ['CV, PI<br><span style="font-size: 12px; color: #52525B;">Site 101 · v1 · signed 12 Jun</span>', ok('Filed')]},
  {'cells': ['Lab normal ranges<br><span style="font-size: 12px; color: #52525B;">Site 101 · v3 · signed 4 Aug</span>', ok('Filed')]}], '13px')
viewer = '''<div style="display: flex; flex-direction: column; gap: 12px; font-size: 13.5px;">
  <div style="height: 300px; border: 1px solid #E5E5EA; border-radius: 8px; background: #FAFAFA; display: flex; flex-direction: column; gap: 10px; padding: 22px 26px; font-size: 12px; color: #6B6B72;">
    <span style="font-weight: 600; color: #3F3F46; font-size: 13px;">PROTOCOL SIGNATURE PAGE</span><span>Protocol MW-301, version 3.0</span>
    <span style="height: 8px; width: 90%; background: #EDEDF1; border-radius: 2px;"></span><span style="height: 8px; width: 80%; background: #EDEDF1; border-radius: 2px;"></span><span style="height: 8px; width: 85%; background: #EDEDF1; border-radius: 2px;"></span>
    <span style="margin-top: auto;">Principal investigator: Dr [Name] · signed [date]</span></div>
  <div style="border: 1px solid #E5E5EA; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px;"><span><strong>Filed by Tom Okafor</strong> · Approved for filing · 6 Oct 2026, 10:42</span><span style="font-size: 12px; color: #52525B;">Part 11 signature · version 2 locked · v1 sent back on 2 Oct (protocol 2.0)</span></div>
  <div style="display: flex; gap: 8px;"><span style="padding: 7px 12px; border-radius: 8px; border: 1px solid #D4D4D8;">Audit trail</span><span style="padding: 7px 12px; border-radius: 8px; border: 1px solid #D4D4D8;">Download</span><span style="flex: 1 1 auto;"></span><span style="padding: 7px 12px; border-radius: 8px; background: #1C1C1E; color: #FFFFFF; font-weight: 500;">Ask the study team</span></div>
</div>'''
body = f'''<div style="width: 1440px; height: 900px; box-sizing: border-box; background: #F4F4F6; font-family: {FONT}; color: #1C1C1E; display: flex; flex-direction: column;">
  <div style="height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 14px; padding: 0 20px; background: #FFFFFF; border-bottom: 1px solid #E5E5EA; font-size: 14px;">
    <span style="font-weight: 800; color: #6E47D1; font-size: 18px;">M</span>
    <span style="font-weight: 600;">Study MW-301 · Trial master file</span>
    <span style="padding: 3px 9px; border-radius: 999px; background: #FDF1DF; color: #8A4B00; font-size: 12.5px; font-weight: 500;">Read only · every view and download is logged</span>
    <span style="flex: 1 1 auto;"></span>
    <span style="color: #52525B;">Inspector, MHRA · access ends Wed 18 Nov, 18:00</span>
  </div>
  <div style="flex: 1 1 auto; display: flex; gap: 8px; padding: 8px; min-height: 0;">
    <nav aria-label="TMF zones" style="width: 236px; flex: 0 0 236px; display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; padding: 6px 4px;">
      <span style="font-size: 12px; font-weight: 600; color: #6B6B72; padding: 4px 10px 6px;">TMF INDEX</span>{tree}
      <span style="flex: 1 1 auto;"></span>
      <span style="font-size: 12px; color: #6B6B72; padding: 8px 10px; line-height: 1.45;">You see filed documents, signatures and the audit trail. Drafts, chats and AI suggestions are not shown.</span>
    </nav>
    <section style="width: 460px; flex: 0 0 460px; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px;">
      <span style="font-size: 13px; color: #52525B;">05 Site management  ›  Site 101</span>
      <label for="isearch" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);">Search the TMF</label>
      <input id="isearch" placeholder="Search filed documents" style="font: inherit; font-size: 14px; padding: 8px 11px; border: 1px solid #D4D4D8; border-radius: 8px;">
      {docs}
      <span style="font-size: 12.5px; color: #6B6B72;">Showing 4 of 61 at site 101</span>
      <div style="margin-top: auto; border-top: 1px solid #F0F0F2; padding-top: 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px;">
        <span style="font-weight: 600;">Your requests</span>
        <span>Training records for the site 104 coordinator · <span style="color: #1B6B3A;">answered by Tom Okafor, 10:20</span></span>
        <span>Why was the site 109 ethics letter filed late? · <span style="color: #8A4B00;">with the study team</span></span>
      </div>
    </section>
    <main style="flex: 1 1 auto; min-width: 0; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; padding: 16px 22px; display: flex; flex-direction: column; gap: 12px;">
      <h2 style="margin: 0; font-size: 20px; font-weight: 600;">Protocol signature page, site 101</h2>
      {viewer}
    </main>
  </div>
</div>'''
W['EInspector'] = page('Inspector view', body)

# ---------- Change control: a chat edit in a regulated project ----------
msgs = [me('Stop the QC step for CVs. The AI check is enough.'),
  ai(chip('Drafted a change: <strong>File a document</strong>, step 3'),
     p('Drafted. This project is regulated, so the change can\'t go live straight from chat. It needs a reason, a validation run and QA\'s signature.'),
     p('I re-filed last month\'s 42 CVs with the new steps. <strong>One result differs:</strong> a CV for site 109 that the AI passed was sent back by QC because it wasn\'t signed.')),
  me('Add a check that the CV is signed and dated, then run it again'),
  ai(chip('Changed the draft: AI check now includes signature and date'), p('Run again: 42 of 42 now match QC. Ready to send to Grace Lee (QA) for signature.'))]
diff = table('28px 1fr 110px', ['', 'Step', 'Who'], [
  {'cells': ['2', 'AI checks: right document type, site, version, expiry' + mark(', and for CVs, signed and dated'), 'Agent'], 'style': ' background: #FBF9FF;'},
  {'cells': ['3', '<span style="color: #8A8A92; text-decoration: line-through;">QC by the TMF lead</span> ' + mark('QC by the TMF lead, except CVs that pass every AI check'), 'TMF lead'], 'style': ' background: #FBF9FF;'},
  ['4', 'Approve for filing (Part 11 signature)', 'TMF lead']], '13px')
val = table('1fr 120px', ['Validation run, on 42 CVs filed in September', 'Result'], [
  ['First run', warn('41 of 42 match QC')],
  ['Second run, with the signature and date check', ok('42 of 42 match QC')]], '13px')
appr = table('1fr 170px', ['Sign-off', 'Status'], [['Anika Rao · study manager · raised the change', ok('Signed 21 Oct')], ['Grace Lee · QA', warn('Waiting')]], '13px')
inner = title('Change request CR-014', 'File a document · regulated project (Part 11) · drafted from chat') + \
  section(h3('What changes'), diff) + \
  section(h3('Reason'), '<span style="font-size: 13.5px; line-height: 1.5;">QC of CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.</span>') + \
  section(h3('Validation'), val) + section(h3('Sign-off'), appr) + \
  '<div style="margin-top: auto; display: flex; gap: 10px; align-items: center; padding-top: 14px; border-top: 1px solid #F0F0F2;"><span style="font-size: 13px; color: #52525B; flex: 1 1 auto;">Goes live as version 3 once QA signs. Version 2 keeps running until then.</span>' + btn('Withdraw', '#') + btn('Send to QA', 'EAudit.dc.html', True) + '</div>'
W['EChange'] = app('Change control', 'active="p-file" ' + SB, chat('Change request CR-014', msgs, 'Ask about this change', 'change', (), 'e3'), main('Playbooks  ›  File a document  ›  Change request CR-014', inner, '6px 28px 20px'))

# ---------- Audit trail: people and AI side by side ----------
msgs = [me('Who touched the protocol signature page for site 101?'),
  ai(p('Four people and the AI, in 9 entries. The site uploaded it twice. The AI flagged version 1 for the old protocol, Tom sent it back, and he signed version 2 on 6 Oct.'),
     p('Every AI entry shows the model and the sentence it relied on, the same as a person\'s reason.'))]
def who(t, ai_=False):
    return f'<span style="display: inline-flex; align-items: center; gap: 6px;">{"<span style=\"padding: 1px 6px; border-radius: 4px; background: #F5F1FF; color: #43239E; font-size: 11px; font-weight: 600;\">AI</span>" if ai_ else ""}{t}</span>'
log = table('92px 170px 1fr', ['When', 'Who', 'What'], [
  ['29 Sep 11:02', who('Site coordinator, 101'), 'Uploaded v1 by link'],
  ['29 Sep 11:03', who('AI check · Sonnet 5.5', True), 'Flagged v1: “Protocol version 2.0” does not match 3.0'],
  ['2 Oct 09:15', who('Tom Okafor'), 'Sent v1 back · reason: signed against protocol 2.0'],
  ['3 Oct 14:40', who('Site coordinator, 101'), 'Uploaded v2 by link'],
  ['5 Oct 16:10', who('AI check · Sonnet 5.5', True), 'Checked v2: 3 of 3 checks passed, with quotes'],
  ['6 Oct 10:42', who('Tom Okafor'), '<strong>Signed v2</strong> · approved for filing · Part 11'],
  ['6 Oct 10:42', who('System'), 'Filed v2 to zone 05 · v2 locked'],
  ['14 Oct 15:31', who('Priya Shah'), 'Viewed v2 during the monitoring visit'],
  ['21 Oct 09:05', who('Anika Rao'), 'Exported this trail for the inspection folder']], '13px')
filt = '<div style="display: flex; gap: 8px; font-size: 13px;"><span style="padding: 4px 10px; border-radius: 999px; background: #F5F1FF; color: #43239E;">Protocol signature page, site 101 ×</span><span style="padding: 4px 10px; border-radius: 999px; background: #F4F4F6;">People and AI</span></div>'
inner = title('Audit trail', 'Every change in Study MW-301, by people and AI · append-only, each entry chained to the one before', btn('Export for inspectors', '#')) + filt + log + \
  '<span style="font-size: 12.5px; color: #6B6B72;">Entries can\'t be edited or deleted. The export is signed, and any later change to an entry would show.</span>'
W['EAudit'] = app('Audit trail', 'active="settings" ' + SB, chat('Audit trail', msgs, 'Ask about the audit trail', 'page', (), 'e4'), main('Study MW-301  ›  Project settings  ›  Audit trail', inner, '6px 28px 20px'))

# ---------- Across studies: a workspace page ----------
msgs = [me('How are our studies doing on the TMF?'),
  ai(p('<strong>MW-301</strong> is in good shape for its inspection on 16 Nov: 98% filed, 23 documents missing.'),
     p('<strong>MW-207</strong> is behind: 61 documents have waited more than 10 days for QC, and the database lock is on 30 Nov. Tom is TMF lead on both, so it\'s worth asking whether 207 needs help.'),
     p('Each study is its own project, because the sites, people and sign-offs differ. This page reads across all of them.'))]
studies = table('80px 50px 46px 54px 64px 104px 1fr', ['Study', 'Phase', 'Sites', 'Filed', 'Missing', 'Waiting for QC', 'Next'], [
  {'href': 'EIndex.dc.html', 'cells': ['<strong>MW-301</strong>', '3', '12', '98%', '23', '8', 'Inspection 16 Nov']},
  {'cells': ['<strong>MW-207</strong>', '2', '6', '91%', '64', warn('61'), 'Lock 30 Nov']},
  {'href': 'NewProject.dc.html', 'cells': ['<strong>MW-310</strong>', '3', mute('0'), mute('n/a'), mute('n/a'), mute('n/a'), 'Draft · Jan']}], '13.5px')
people = table('1fr 1fr', ['Person', 'Waiting on them, across studies'], [['Tom Okafor · TMF lead', '8 in MW-301 · ' + warn('61 in MW-207')], ['Grace Lee · QA', '1 change request in MW-301'], ['Priya Shah · CRA', '1 visit report in MW-301']], '13.5px')
inner = title('TMF across studies', 'The eTMF app home · reads every study you can see') + \
  tiles([('Studies', '3', '2 running, 1 draft'), ('Documents filed', '96%', 'across running studies'), ('Inspections', '1', 'MW-301, 16 Nov')]) + \
  section(h3('Studies'), studies) + section(h3('Who is the bottleneck'), people)
W['EPortfolio'] = app('Across studies', 'active="home" project="all"', chat('TMF across studies', msgs, 'Ask across studies', 'page', (), 'e5'), main('eTMF  ›  All studies', inner, '6px 28px 20px'))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
