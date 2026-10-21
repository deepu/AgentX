from build_lib import *
W = {}
SB = 'project="edc"'

def mute(t):
    return f'<span style="color: #6B6B72;">{t}</span>'
def warn(t):
    return f'<span style="color: #8A4B00; font-weight: 500;">{t}</span>'
def owner(app_):
    c = {'EDC': ('#E3F1F1', '#1D5F60'), 'eTMF': ('#E4EEF8', '#24578A')}[app_]
    return f'<span style="padding: 2px 8px; border-radius: 999px; background: {c[0]}; color: {c[1]}; font-size: 12px; font-weight: 600; white-space: nowrap;">{app_}</span>'
def apphead(name, color, mark, n, href):
    return f'<a href="{href}" style="display: flex; align-items: center; gap: 10px; color: #1C1C1E; text-decoration: none;"><span style="width: 26px; height: 26px; border-radius: 8px; background: {color}; color: #FFFFFF; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;">{mark}</span><span style="font-size: 14.5px; font-weight: 600; flex: 1 1 auto;">{name} <span style="color: #6B6B72; font-weight: 400;">{n}</span></span><span style="font-size: 13px; color: #5B34C9;">Open project</span></a>'
def more(t, href='#'):
    return f'<a href="{href}" style="font-size: 13px; padding-left: 2px;">{t}</a>'
def group(head, rows):
    return f'<section style="display: flex; flex-direction: column; gap: 8px;">{head}' + ''.join(rows) + '</section>'

# ---------- Waiting for you, across every app ----------
msgs = [me('What needs me first?'),
  ai(p('<strong>18 things across 3 apps.</strong> Two are due this week:'),
     ul('Sign Priya\'s visit report for site 101 in eTMF, due Wednesday.', 'Approve the query reminders in EDC, so they go out on Monday.'),
     p('Site 104 shows up in both apps: 4 documents missing in eTMF and 9 old queries in EDC. Worth one call to the site rather than two emails.'))]
inner = title('Waiting for you', 'Everything across your projects · grouped by project') + \
  group(apphead('eTMF · Study MW-301', '#2F6FAE', 'TMF', 3, 'Main.dc.html'), [
    waitrow('Sign the monitoring visit report', 'Site 101 · visit on 14 Oct · written by Priya Shah', 'From Review a visit report', 'Sign.dc.html', flag='Due Wed'),
    waitrow('Approve a reminder email', 'Site 104 · 4 documents missing', 'From Chase missing documents', 'Run.dc.html'),
    more('1 more in MW-301', 'Waiting.dc.html')]) + \
  group(apphead('EDC · Study MW-301', '#2C7A7B', 'EDC', 8, 'XEdcHome.dc.html'), [
    waitrow('Approve query reminders', 'Sites 104, 109 and 3 others · 23 queries older than 14 days', 'From Chase old queries · goes out Monday', 'XQueries.dc.html', flag='Due Mon'),
    more('7 more in EDC: data review sign-offs')]) + \
  group(apphead('eTMF · Study MW-207', '#2F6FAE', 'TMF', 5, '#'), [more('5 waiting · 61 documents behind in QC')]) + \
  group(apphead('Literature search', '#B4532A', 'Lit', 2, 'LHome.dc.html'), [more('Review an answer change · Weight loss', 'LChange.dc.html')])
W['XWaitingAll'] = app('Waiting for you, all apps', 'active="waiting" project="inbox"', chat('Waiting for you', msgs, 'Ask about what\'s waiting, in any app', 'page', (), 'x1'), main('All projects  ›  Waiting for you', inner, '6px 28px 20px'))

# ---------- EDC app: MW-301 home ----------
left = f'''    <section aria-label="Chat" style="width: 488px; flex: 0 0 488px; box-sizing: border-box; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; display: flex; flex-direction: column; padding: 0 32px;">
      <div style="flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 22px;">
        <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 30px; text-align: center;">What do you want to know about MW-301?</h1>
        <form style="display: flex; flex-direction: column;">
          <label for="xask" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);">Your question</label>
          <div style="border: 1.5px solid #9C86E8; border-radius: 16px; padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 18px;">
            <textarea id="xask" rows="2" placeholder="Ask about subjects, visits or queries" style="border: 0; outline: none; resize: none; font: inherit; font-size: 16px; color: #1C1C1E; background: transparent;"></textarea>
            <div style="display: flex; align-items: center; gap: 8px; color: #52525B; font-size: 14px;">
              <span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">Medidata Rave</span>
              <span style="flex: 1 1 auto;"></span><span>Sonnet 5.5 ⌄</span>
              <a href="XQueries.dc.html" aria-label="Ask" style="width: 32px; height: 32px; border-radius: 50%; background: #1C1C1E; color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; text-decoration: none;">{SEND}</a>
            </div>
          </div>
        </form>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: #52525B;">Try asking</span>
          <a href="XQueries.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">Which sites have queries older than 14 days?</a>
          <a href="XEdcHome.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">Are we on track to lock the database in March?</a>
        </div>
        <span style="font-size: 12.5px; color: #6B6B72; text-align: center;">Data entry stays in Rave. MemWise reads it and chases it.</span>
      </div>
    </section>'''
alsoin = '<a href="Main.dc.html" style="display: flex; align-items: center; gap: 12px; padding: 11px 14px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 13.5px;"><span style="width: 26px; height: 26px; border-radius: 8px; background: #2F6FAE; color: #FFFFFF; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;">TMF</span><span style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px;"><span><strong>Same study in eTMF</strong> · 98% filed · inspection 16 Nov</span><span style="font-size: 12.5px; color: #6B6B72;">Shares sites, site staff and visit dates with this project</span></span><span style="color: #5B34C9;">Open</span></a>'
inner = title('Study MW-301', 'EDC · connected to Medidata Rave, read only · synced 6 min ago') + \
  tiles([('Randomised', '186', 'of 300 · plan was 190 by now'), ('Open queries', '142', '23 older than 14 days'), ('Pages verified', '91%', 'source data checks')]) + \
  section(h3('Waiting for you', 8), '<div style="display: flex; flex-direction: column; gap: 8px;">' +
    waitrow('Approve query reminders', 'Sites 104, 109 and 3 others · 23 queries older than 14 days', 'From Chase old queries · goes out Monday', 'XQueries.dc.html', flag='Due Mon') +
    more('7 more: data review sign-offs', 'XWaitingAll.dc.html') + '</div>') + \
  section(h3('Randomised against target, by site'), bars([('Site 101', 96), ('Site 102', 84), ('Site 104', 58), ('Site 109', 71)]) + '<a href="XSite.dc.html" style="font-size: 13px;">Why is site 104 behind?</a>') + \
  section(h3('Also in other apps'), alsoin)
W['XEdcHome'] = app('EDC study home', 'active="home" ' + SB, left, main('Home  ›  Pinned page: Enrolment', inner, '4px 28px 20px'))

# ---------- EDC: a page built from a question ----------
msgs = [me('Which sites have queries older than 14 days?'),
  ai(tools('Read 142 open queries from Medidata Rave', 'Grouped them by site and age'),
     p('<strong>23 queries at 5 sites are older than 14 days.</strong> Sites 104 and 109 have 17 of them. At 104 they are mostly missing visit 3 weights.'),
     p('Site 104 is also behind on documents in eTMF, so it may be one staffing problem, not two.'),
     p('Chase old queries emails sites on Monday. Keep this page and I\'ll refresh it before each run?'))]
right_btn = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">' + btn('Keep, refresh before each run', 'XEdcHome.dc.html', True) + '<span style="font-size: 12px; color: #52525B;">Feeds <a href="#">Chase old queries</a></span></span>'
bysite = table('84px 130px 76px 1fr', ['Site', 'Older than 14 days', 'Oldest', 'Most common'], [
  {'href': 'XSite.dc.html', 'cells': ['<strong>Site 104</strong>', warn('9'), '31 days', 'Visit 3 weight missing']},
  {'cells': ['<strong>Site 109</strong>', warn('8'), '26 days', 'Lab date outside the window']},
  {'cells': ['Site 102', '3', '19 days', 'Concomitant medication dose']},
  {'cells': ['Site 106', '2', '17 days', 'Visit 3 weight missing']},
  {'cells': ['Site 111', '1', '15 days', 'Adverse event end date']}])
oldest = table('110px 70px 1fr 70px', ['Subject', 'Visit', 'Query', 'Age'], [
  ['104-007', 'Visit 3', 'Weight not entered', '31 days'],
  ['109-012', 'Visit 2', 'Lab sample date is 9 days after the visit', '26 days'],
  ['104-003', 'Visit 3', 'Weight not entered', '24 days']], '13px')
inner = title('Old queries by site', pill('Draft page') + '  Built for your question · reads Rave', right_btn) + \
  p('<span style="font-size: 15px;"><strong>23 queries</strong> are older than 14 days. Sites 104 and 109 have most of them.</span>') + \
  section(h3('By site'), bysite) + section(h3('Oldest'), oldest) + \
  '<span style="font-size: 12.5px; color: #6B6B72;">Sites answer queries in Rave. This page reads them; it never closes or edits one.</span>'
W['XQueries'] = app('EDC: a page from a question', 'active="dp-q" draft="true" ' + SB,
  chat('Old queries by site', msgs, 'Ask about this page, or ask to change it', 'page', ('Medidata Rave',), 'x2'),
  main('Pages  ›  Old queries by site', inner, '6px 28px 20px'))

# ---------- EDC: one site, facts owned by one app each ----------
msgs = [me('Why is site 104 behind?'),
  ai(p('<strong>Probably one cause showing up in both apps.</strong> A new coordinator started on 2 Sep.'),
     ul('In EDC, 9 queries are older than 14 days, mostly visit 3 weights not entered.', 'In eTMF, 4 documents are missing, including the new coordinator\'s CV.'),
     p('Priya visits on 28 Oct. I can add both to her visit plan in eTMF.'))]
facts = table('170px 1fr 70px', ['About the site', 'Now', 'Owned by'], [
  ['Principal investigator', 'Dr [Name]', owner('EDC')],
  ['Coordinator', '[Name], since 2 Sep', owner('EDC')],
  ['Randomised', '7 of 12', owner('EDC')],
  ['Open queries', '14 · ' + warn('9 older than 14 days'), owner('EDC')],
  ['Documents in place', warn('61%') + ' · 4 missing', owner('eTMF')],
  ['Next monitoring visit', '28 Oct · Priya Shah', owner('eTMF')]])
right = btn('Open in eTMF', 'Site.dc.html')
inner = title('Site 104 · [Hospital name]', 'A site in Study MW-301 · the same record in EDC and eTMF', right) + \
  tiles([('Randomised', '7', 'of 12 · 58%'), ('Old queries', '9', 'older than 14 days'), ('Documents', '61%', 'from eTMF')]) + \
  section(h3('One record, each fact owned by one app'), facts) + \
  note('The other app shows a fact read only and links back to its owner. When Rave records a new coordinator, eTMF asks the site for their CV and GCP training.')
W['XSite'] = app('One site in two apps', 'active="dr-sites" ' + SB, chat('Site 104', msgs, 'Ask about this site', 'page', (), 'x3'), main('Records  ›  Sites  ›  Site 104', inner))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
