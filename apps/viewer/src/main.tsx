import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { MotionPreferenceProvider } from '@memwise/ui/motion'
import { App } from './App'
import { setupI18n } from '@memwise/shared/i18n'
import { initReactI18next } from 'react-i18next'
import './index.css'

// Initialize i18n before any React rendering
setupI18n([initReactI18next])

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <React.StrictMode>
    <MotionPreferenceProvider>
      <App />
    </MotionPreferenceProvider>
  </React.StrictMode>
)
