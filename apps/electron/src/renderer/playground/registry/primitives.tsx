import * as React from 'react'
import { motion } from 'motion/react'
import {
  Archive,
  Bell,
  Copy,
  FileText,
  Pencil,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Share,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { SPRING, TWEEN } from '@memwise/ui/motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '@memwise/ui'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'
import { useDelayedLoading } from '@/hooks/useDelayedLoading'
import { cn } from '@/lib/utils'
import type { ComponentEntry } from './types'

// ============================================================================
// Design system primitives (implementation plan A1–A5). Each demo renders in the
// active theme and mode, so the playground theme picker doubles as a theme audit.
// ============================================================================

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label-sm font-medium text-tertiary">{title}</h3>
      <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
    </section>
  )
}

// ── Tokens ──────────────────────────────────────────────────────────────────

const SURFACES = ['navigator', 'paper', 'raised', 'sunken', 'floating'] as const
const TEXT_TIERS = [
  ['text', 'text-foreground'],
  ['text-secondary', 'text-secondary'],
  ['text-tertiary', 'text-tertiary'],
  ['text-disabled', 'text-disabled'],
] as const
const STATUS = [
  ['accent', 'text-accent', 'bg-accent-tint', 'bg-accent-solid text-on-accent'],
  ['info', 'text-info', 'bg-info-tint', 'bg-info-solid text-on-info'],
  ['success', 'text-success', 'bg-success-tint', 'bg-success-solid text-on-success'],
  ['destructive', 'text-destructive', 'bg-destructive-tint', 'bg-destructive-solid text-on-destructive'],
] as const

function TokensDemo() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6 p-6">
      <Section title="Surfaces (solved from the theme's 6 colors)" className="grid grid-cols-5 gap-2">
        {SURFACES.map((surface) => (
          <div
            key={surface}
            className="flex h-20 flex-col justify-between rounded-md p-2.5 shadow-elev-0"
            style={{ background: `var(--surface-${surface})` }}
          >
            <span className="text-label font-medium">{surface}</span>
            <span className="text-label-sm text-secondary">--surface-{surface}</span>
          </div>
        ))}
      </Section>
      <Section title="Text tiers (AA on every surface and state fill)" className="grid grid-cols-4 gap-2">
        {TEXT_TIERS.map(([name, cls]) => (
          <div key={name} className="rounded-md bg-paper p-2.5 shadow-elev-0">
            <div className={cn('text-label font-medium', cls)}>The quick brown fox</div>
            <div className="text-label-sm text-tertiary">--{name}</div>
          </div>
        ))}
      </Section>
      <Section title="Status: text · tint chip · solid">
        {STATUS.map(([name, text, tint, solid]) => (
          <div key={name} className="flex items-center gap-2 rounded-md bg-paper p-2 shadow-elev-0">
            <span className={cn('text-label font-medium', text)}>{name}</span>
            <span className={cn('inline-flex h-5 items-center rounded-xs px-1.5 text-label-sm', tint, text)}>chip</span>
            <span className={cn('inline-flex h-5 items-center rounded-xs px-1.5 text-label-sm font-medium', solid)}>solid</span>
          </div>
        ))}
      </Section>
      <Section title="Elevation" className="grid grid-cols-4 gap-4">
        {(['shadow-elev-0', 'shadow-elev-1', 'shadow-elev-2', 'shadow-elev-3'] as const).map((elev) => (
          <div key={elev} className={cn('grid h-16 place-items-center rounded-lg bg-raised text-label-sm text-secondary', elev)}>
            {elev}
          </div>
        ))}
      </Section>
      <Section title="Type roles (16px root, whole pixels)" className="flex-col items-start gap-1">
        <span className="text-caption text-secondary">caption 11/14</span>
        <span className="text-label-sm">label-sm 12/16</span>
        <span className="text-label">label 13/18</span>
        <span className="text-label-lg font-medium">label-lg 14/20</span>
        <span className="text-copy">copy 15/24 — answers and descriptions</span>
        <span className="text-copy-lg">copy-lg 16/26</span>
        <span className="text-title">title 20/28</span>
        <span className="font-serif text-display">Display 30/36</span>
        <span className="font-mono text-mono-ui text-secondary">mono-ui 12/18 · packages/ui/src/styles/tokens.css</span>
      </Section>
      <Section title="Radii (xs 4 · sm 6 · md 8 · lg 12 · xl 16)" className="gap-4">
        {(['rounded-xs', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl'] as const).map((radius) => (
          <div key={radius} className={cn('grid size-14 place-items-center bg-raised text-caption text-tertiary shadow-elev-1', radius)}>
            {radius.replace('rounded-', '')}
          </div>
        ))}
      </Section>
    </div>
  )
}

// ── Buttons ─────────────────────────────────────────────────────────────────

function ButtonsDemo({ disabled }: { disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Section title="Variants">
        <Button disabled={disabled}>Continue</Button>
        <Button variant="secondary" disabled={disabled}>Secondary</Button>
        <Button variant="ghost" disabled={disabled}>Cancel</Button>
        <Button variant="danger" disabled={disabled}>Remove</Button>
        <Button variant="danger-solid" disabled={disabled}>Delete forever</Button>
        <Button variant="link" disabled={disabled}>Learn more</Button>
      </Section>
      <Section title="Sizes (24 · 28 · 32 · 40)">
        <Button size="sm" disabled={disabled}>Small</Button>
        <Button disabled={disabled}>Default</Button>
        <Button size="lg" disabled={disabled}><Plus />New session</Button>
        <Button size="xl" disabled={disabled}>Get started</Button>
      </Section>
      <Section title="Icon buttons (always named; tooltip + keycaps)">
        <IconButton aria-label="Toggle sidebar" icon={<PanelLeft />} tooltip shortcut={['⌘', 'B']} disabled={disabled} />
        <IconButton aria-label="Search" icon={<Search />} tooltip shortcut={['⌘', 'K']} disabled={disabled} />
        <IconButton aria-label="Share" icon={<Share />} tooltip disabled={disabled} />
        <IconButton aria-label="Settings" icon={<Settings />} size="lg" tooltip disabled={disabled} />
        <IconButton aria-label="Notifications" icon={<Bell />} size="sm" aria-pressed disabled={disabled} />
      </Section>
    </div>
  )
}

// ── Fields ──────────────────────────────────────────────────────────────────

function FieldsDemo({ invalid }: { invalid?: boolean }) {
  const [enabled, setEnabled] = React.useState(true)
  const [view, setView] = React.useState('list')
  return (
    <div className="flex w-[420px] flex-col gap-6 p-6">
      <Section title="Input · Select" className="flex-col items-stretch">
        <Input placeholder="Workspace name" aria-invalid={invalid || undefined} aria-label="Workspace name" />
        <Select defaultValue="opus">
          <SelectTrigger aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opus">Opus 5.5</SelectItem>
            <SelectItem value="sonnet">Sonnet 5</SelectItem>
            <SelectItem value="haiku">Haiku 4.5</SelectItem>
          </SelectContent>
        </Select>
        <Textarea placeholder="Describe the task…" aria-label="Task description" />
      </Section>
      <Section title="Switch (off state keeps a 3:1 outline)">
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
        <Switch checked={!enabled} onCheckedChange={(v) => setEnabled(!v)} aria-label="Disabled state demo" />
        <Switch disabled aria-label="Unavailable" />
      </Section>
      <Section title="Segmented (selected item is raised)">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="pages">Pages</TabsTrigger>
          </TabsList>
        </Tabs>
      </Section>
      <Section title="Keycaps">
        <KbdGroup><Kbd>⌘</Kbd><Kbd>K</Kbd></KbdGroup>
        <KbdGroup><Kbd>⌥</Kbd><Kbd>↵</Kbd></KbdGroup>
        <Kbd>Esc</Kbd>
      </Section>
    </div>
  )
}

// ── Overlays ────────────────────────────────────────────────────────────────

function MenuDemo({ open }: { open?: boolean }) {
  const [showArchived, setShowArchived] = React.useState(true)
  return (
    <div className="p-6">
      <DropdownMenu open={open} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">Session actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem><Pencil />Rename…<DropdownMenuShortcut>⌘R</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem><Copy />Copy link</DropdownMenuItem>
          <DropdownMenuItem><Share />Share…</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>Show archived</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem><Archive />Archive<DropdownMenuShortcut>E</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem variant="destructive"><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DialogDemo({ open }: { open?: boolean }) {
  return (
    <Dialog open={open}>
      <DialogTrigger asChild>
        <Button variant="secondary">Rename session</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Names show in the session list, search and the window title.</DialogDescription>
        </DialogHeader>
        <Input defaultValue="Quarterly planning notes" aria-label="Session name" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TooltipPopoverDemo({ open }: { open?: boolean }) {
  return (
    <div className="flex items-center gap-10 p-10">
      <Tooltip open={open}>
        <TooltipTrigger asChild>
          <Button variant="secondary">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          New session
          <KbdGroup><Kbd>⌘</Kbd><Kbd>N</Kbd></KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Popover open={open}>
        <PopoverTrigger asChild>
          <Button variant="secondary">Popover</Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" className="flex flex-col gap-2">
          <span className="text-label-lg font-semibold">Working folder</span>
          <span className="text-label text-secondary">Sessions start here unless a project sets its own folder.</span>
          <Input defaultValue="~/Workspace/memwise" aria-label="Working folder" />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function CommandPaletteDemo() {
  return (
    <div className="w-[640px] overflow-hidden rounded-xl shadow-elev-3">
      <Command>
        <CommandInput placeholder="Search sessions, actions, sources…" />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandGroup heading="Suggested">
            <CommandItem><Sparkles />New session<CommandShortcut><KbdGroup><Kbd>⌘</Kbd><Kbd>N</Kbd></KbdGroup></CommandShortcut></CommandItem>
            <CommandItem><Search />Search transcripts<CommandShortcut><KbdGroup><Kbd>⌘</Kbd><Kbd>F</Kbd></KbdGroup></CommandShortcut></CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Sessions">
            <CommandItem><FileText />Quarterly planning notes<CommandShortcut>2h</CommandShortcut></CommandItem>
            <CommandItem><FileText />Fix flaky BrowserPaneManager tests<CommandShortcut>Yesterday</CommandShortcut></CommandItem>
            <CommandItem disabled><FileText />Archived: onboarding copy review</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}

// ── Loading + motion ────────────────────────────────────────────────────────

function SkeletonDemo({ loadMs = 1200 }: { loadMs?: number }) {
  const [loading, setLoading] = React.useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const reload = React.useCallback(() => {
    setLoading(true)
    window.setTimeout(() => setLoading(false), loadMs)
  }, [loadMs])
  React.useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), loadMs)
    return () => window.clearTimeout(timer)
  }, [loadMs])

  return (
    <div className="flex w-[360px] flex-col gap-4 p-6">
      <div className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-elev-1">
        {showSkeleton ? (
          <>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </>
        ) : loading ? (
          <div className="h-[58px]" />
        ) : (
          <>
            <span className="text-label-lg font-semibold">Quarterly planning notes</span>
            <span className="text-label text-secondary">Skeletons appear only after 200ms and stay at least 400ms.</span>
          </>
        )}
      </div>
      <Button variant="secondary" onClick={reload}>Reload ({loadMs}ms)</Button>
    </div>
  )
}

function MotionPresetsDemo() {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="flex w-[420px] flex-col gap-4 p-6">
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setOpen((v) => !v)}>Toggle</Button>
      </div>
      {(['snap', 'base', 'panel', 'gentle', 'gesture'] as const).map((name) => (
        <div key={name} className="flex items-center gap-3">
          <span className="w-16 text-label-sm text-secondary">{name}</span>
          <div className="relative h-6 flex-1 rounded-full bg-fill-hover">
            <motion.div
              className="absolute top-1 left-1 size-4 rounded-full bg-accent-solid"
              animate={{ x: open ? 0 : 300 }}
              transition={SPRING[name]}
            />
          </div>
        </div>
      ))}
      <motion.div
        className="rounded-md bg-sunken p-3 text-label text-secondary"
        animate={{ opacity: open ? 1 : 0.3 }}
        transition={TWEEN.fast}
      >
        Opacity uses TWEEN.fast; reduced motion keeps fades and drops movement.
      </motion.div>
    </div>
  )
}

// ============================================================================
// Registry
// ============================================================================

export const primitivesComponents: ComponentEntry[] = [
  {
    id: 'primitives-tokens',
    name: 'Design Tokens',
    category: 'Primitives',
    description: 'Surfaces, text tiers, status roles, elevation, type and radii — solved per theme (tokens.css + theme-roles.ts)',
    component: TokensDemo,
    props: [],
    layout: 'top',
  },
  {
    id: 'primitives-buttons',
    name: 'Buttons',
    category: 'Primitives',
    description: 'One primary (accent solid), secondary, ghost, danger, danger-solid, link; IconButton requires a name',
    component: ButtonsDemo,
    props: [{ name: 'disabled', description: 'Disable every control', control: { type: 'boolean' }, defaultValue: false }],
    variants: [
      { name: 'Enabled', props: { disabled: false } },
      { name: 'Disabled', props: { disabled: true } },
    ],
  },
  {
    id: 'primitives-fields',
    name: 'Fields',
    category: 'Primitives',
    description: 'Input, Select, Textarea (sunken + focus tint), Switch 40×24, segmented Tabs, keycaps',
    component: FieldsDemo,
    props: [{ name: 'invalid', description: 'aria-invalid on the input', control: { type: 'boolean' }, defaultValue: false }],
    variants: [
      { name: 'Default', props: { invalid: false } },
      { name: 'Invalid', props: { invalid: true } },
    ],
  },
  {
    id: 'primitives-menu',
    name: 'Menu',
    category: 'Primitives',
    description: 'Floating material, 30px rows, keycap slot, destructive item; enter 150ms scale .96 → 1, exit 100ms fade',
    component: MenuDemo,
    props: [{ name: 'open', description: 'Force open', control: { type: 'boolean' }, defaultValue: true }],
    layout: 'top',
    previewOverflow: 'visible',
  },
  {
    id: 'primitives-dialog',
    name: 'Dialog',
    category: 'Primitives',
    description: 'Radius 16, elev-3, scrim; 200ms rise + scale .97, exit 140ms',
    component: DialogDemo,
    props: [{ name: 'open', description: 'Force open', control: { type: 'boolean' }, defaultValue: true }],
  },
  {
    id: 'primitives-tooltip-popover',
    name: 'Tooltip & Popover',
    category: 'Primitives',
    description: 'Tooltip: 500ms delay, 300ms skip window, keycaps. Popover: floating material',
    component: TooltipPopoverDemo,
    props: [{ name: 'open', description: 'Force open', control: { type: 'boolean' }, defaultValue: true }],
    layout: 'top',
    previewOverflow: 'visible',
  },
  {
    id: 'primitives-command',
    name: 'Command Palette',
    category: 'Primitives',
    description: 'cmdk on the floating material: 52px input, 38px rows, accent bar on the selected row',
    component: CommandPaletteDemo,
    props: [],
  },
  {
    id: 'primitives-skeleton',
    name: 'Skeleton',
    category: 'Primitives',
    description: 'Skeleton + useDelayedLoading(200ms delay, 400ms minimum); static under reduced motion',
    component: SkeletonDemo,
    props: [{ name: 'loadMs', description: 'Simulated load time', control: { type: 'number', min: 0, max: 5000, step: 100 }, defaultValue: 1200 }],
    variants: [
      { name: 'Slow load', props: { loadMs: 1200 } },
      { name: 'Fast load (no skeleton)', props: { loadMs: 120 } },
    ],
  },
  {
    id: 'primitives-motion',
    name: 'Motion Presets',
    category: 'Primitives',
    description: 'SPRING.snap/base/panel/gentle/gesture and TWEEN from @memwise/ui/motion',
    component: MotionPresetsDemo,
    props: [],
  },
]
