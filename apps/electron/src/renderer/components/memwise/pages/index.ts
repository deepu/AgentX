/**
 * Pages (docs/memwise/26-projects-and-pages.md §4): the screens the project shell mounts in its
 * right column, the pieces for Home and the sidebar, and their data hooks.
 */
export { PageScreen, PageView, type PageScreenProps, type PageViewProps } from './PageScreen'
export { PageChangeScreen, PageChangeView, decidedLine, type PageChangeScreenProps, type PageChangeViewProps } from './PageChangeScreen'
export { PagesKeptTable, keptPages, saysNow, type PagesKeptTableProps } from './PagesKeptTable'
export { WhatChangedCard, WhatChangedThisWeek, changedThisWeek, nothingElseMoved, type WhatChangedCardProps, type WhatChangedThisWeekProps } from './WhatChangedCard'
export { PageBody, type PageBodyProps } from './PageBody'
export * from './page-model'
export {
  hasPageCalls, pageChangeMatches, pagesChangeMatches, useMemwisePage, useMemwisePageCalls, useMemwisePageChange, useMemwisePages,
  useMemwisePageVersions, type MemwisePageCalls,
} from '@/hooks/useMemwisePages'
