import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { parseRoute } from './route'
import { FormPage } from './FormPage'
import { InboxPage } from './InboxPage'
import { InspectorPage } from './InspectorPage'
import { RefusalPage } from './ui'
import './styles.css'

function App() {
  const route = parseRoute(window.location.pathname)
  if (!route) return <RefusalPage refusal={{ status: 'unknown', message: '' }} />
  if (route.kind === 'inspector') return <InspectorPage apiBase={route.api} />
  return route.kind === 'form' ? <FormPage apiBase={route.api} /> : <InboxPage apiBase={route.api} />
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
