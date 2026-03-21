# Benchmark Color Theme System

## Overview

The benchmark UI uses two coordinated palettes:

- **Category colors** for badges, tabs, and benchmark identity
- **Level colors** for difficulty indicators and execution progress

## Category Palette

Canonical benchmark category colors come from [`config/categories.js`](/home/yb/codes/AgentX/config/categories.js):

| Category | Color | Usage |
|----------|-------|-------|
| `coding` | `#7c9fff` | Coding tabs, badges, charts |
| `reasoning` | `#a78bfa` | Reasoning summaries and category pills |
| `math` | `#fbbf24` | Math badges and score accents |
| `knowledge` | `#34d399` | Knowledge cards and comparisons |
| `instruction` | `#06b6d4` | Instruction compliance visuals |
| `creative` | `#f87171` | Creative category highlights |
| `translation` | `#f472b6` | Translation tabs and labels |

## Level Palette

Difficulty still has its own 5-level visual scale:

| Level | Label | Theme |
|-------|-------|-------|
| 1 | Basic | Green |
| 2 | Intermediate | Emerald |
| 3 | Advanced | Amber |
| 4 | Expert | Cyan |
| 5 | Master | Gold |

## Usage Guidance

- Use **category colors** when the UI is communicating *what kind of task* a result belongs to.
- Use **level colors** when the UI is communicating *how difficult* a prompt or run is.
- Do not introduce legacy benchmark category colors for retired categories.

## Source of Truth

- Category metadata: [`config/categories.js`](/home/yb/codes/AgentX/config/categories.js)
- Benchmark UI styles: [`public/css/benchmark-inline.css`](/home/yb/codes/AgentX/public/css/benchmark-inline.css)
- Category badge styles: [`public/css/components/category-badge.css`](/home/yb/codes/AgentX/public/css/components/category-badge.css)
