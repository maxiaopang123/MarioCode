/** English mirror of `zh/chat-stream.ts`. */
export const en = {
  "chatStream.image.shownInReply": "Image shown in reply · expand tool preview",
  // ── MessageTimeline ──
  "chatStream.timeline.current": "Current",
  "chatStream.timeline.noText": "(no text)",
  "chatStream.timeline.attachmentLine": "[Attachment] {text}",

  // ── MessageRow: user prompt overflow (5-line collapse) ──
  "chatStream.userMsg.expand": "Expand",
  "chatStream.userMsg.collapse": "Collapse",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} operations",

  // ── Chat stream · Plan A (spine): turn summary / reply mark ──
  "chatStream.stepCount": "{n} steps",
  "chatStream.filesChanged": "{n} files changed",
  "chatStream.waitingModel": "Waiting for model…",

  // ── Running ledger (borderless form) header ──
  "chatStream.ledgerRunning": "Running",
  "chatStream.tokensUsed": "{n} tokens",
  "chatStream.filesChangedShort": "{n} files",

  // ── RenderErrorBoundary: per-segment render-failure fallback ──
  "chatStream.renderError": "This item failed to render and was skipped (everything else is unaffected)",

  // ── MessageBlocks: thinking / tool cards ──
  "chatStream.thinking": "Thinking",
  "chatStream.tool.input": "Input",
  "chatStream.tool.result": "Result",
  "chatStream.lineCount": "{n} lines",
  "chatStream.emptyPlaceholder": "(empty)",
  "chatStream.truncatedSuffix": "(truncated)",

  // ── MessageBlocks: compact summary ──
  "chatStream.compact.manual": "History compacted manually",
  "chatStream.compact.auto": "History compacted automatically",
  "chatStream.compact.freed": "· Freed {n} tokens",

  // ── MessageBlocks: images ──
  "chatStream.image.browserScreenshot": "Browser screenshot",
  "chatStream.image.userImage": "User image",
  "chatStream.imageRenderedAbove": "[image rendered above]",

  // ── MessageBlocks: image gallery ──
  "chatStream.gallery.screenshotAlt": "Screenshot {n}/{total}",
  "chatStream.gallery.prev": "Previous",
  "chatStream.gallery.next": "Next",
  "chatStream.gallery.imageN": "Image {n}",

  // ── MessageBlocks: attachment chip ──
  "chatStream.attachment.viewImage": "View image",
  "chatStream.attachment.viewContent": "View content",
  "chatStream.attachment.collapseImage": "Collapse image",
  "chatStream.attachment.collapseContent": "Collapse content",

  // ── Markdown ──
  "chatStream.copyCode": "Copy code",
  "chatStream.code.expand": "Expand",
  "chatStream.code.collapse": "Collapse",

  // ── FileLink ──
  "chatStream.fileLink.clickToOpen": "Click to open file",
  "chatStream.fileLink.noMatch": "No matching files found",
  "chatStream.fileLink.matchCount": "{n} matches · pick one to open",

  // ── DiffView / Write card diff labels ──
  "chatStream.diff.noChanges": "(no changes)",
  "chatStream.diff.newFile": "New file",
  "chatStream.diff.vsPreTurn": "Diff vs pre-turn",
  "chatStream.diff.newFileContent": "New file content",

  // ── TurnFilesCard ──
  "chatStream.turnFiles.titleLong": "Modified {n} files this turn",
  "chatStream.turnFiles.titleShort": "{n} files changed",
  "chatStream.turnFiles.created": "{n} created",
  "chatStream.turnFiles.modified": "{n} modified",
  "chatStream.turnFiles.rewindLong": "Undo this turn",
  "chatStream.turnFiles.rewindShort": "Undo",
  "chatStream.turnFiles.rewinding": "Undoing…",
  "chatStream.turnFiles.rewoundCheck": "Undone ✓",
  "chatStream.turnFiles.rewoundBadge": "Undone",
  "chatStream.turnFiles.rewindLatestTitle": "Restore all files from this turn to their pre-turn state",
  "chatStream.turnFiles.rewindHistoryTitle":
    "Restore this past turn's file changes to their pre-edit state (may affect later turns)",
  "chatStream.turnFiles.confirmTitle": "Undo this turn's changes",
  "chatStream.turnFiles.confirmDescLatest": "Files changed this turn will be restored to their pre-turn state.",
  "chatStream.turnFiles.confirmDescHistory1": "Undoing a past turn restores its changed files to their pre-edit state,",
  "chatStream.turnFiles.confirmDescHistory2": "which may affect later turns that edited the same files. Continue?",
  "chatStream.turnFiles.reviewDiff": "Review changes in the editor",
  "chatStream.turnFiles.locateTitle": "Reveal this file in the file tree",
  "chatStream.turnFiles.createdThisTurn": "Created this turn",
  "chatStream.turnFiles.modifiedThisTurn": "Modified this turn",
  "chatStream.turnFiles.noChanges": "No changes",

  // ── Activity rail + console (chat right edge) ──
  "chatStream.activity.close": "Close",
  "chatStream.activity.now": "now",
  "chatStream.activity.emptyGroup": "Nothing in this filter",
  "chatStream.activity.tabAll": "All",
  // Collapsing cluster (方案 B) — round button + urgency-grown text bar
  "chatStream.activity.cluster.aria": "Activity",
  // 「本会话」 float (chat stream's top-right corner, folds into a pill)
  "chatStream.float.title": "This session",
  "chatStream.float.turnN": "Turn {n}",
  "chatStream.float.expand": "Expand session overview",
  "chatStream.float.fold": "Collapse session overview",
  "chatStream.float.needsYou": "Needs you",
  "chatStream.float.taskFrac": "Tasks {done}/{total}",
  "chatStream.float.agentsN": "{n} subagents",
  "chatStream.float.tasks": "Tasks",
  "chatStream.float.subagents": "Subagents",
  "chatStream.float.plans": "Plans",
  "chatStream.float.planUntitled": "Untitled plan",
  "chatStream.float.bookmarks": "Bookmarks",
  "chatStream.float.renameBookmark": "Bookmark title",
  "chatStream.float.bookmarkStale": "That message is no longer in the transcript",
  "chatStream.float.outline": "Outline",
  "chatStream.float.outlineSteps": "{n} steps",
  "chatStream.float.outlineFiles": "Files +{add} −{del}",
  "chatStream.float.outlineUntitled": "(no text)",
  "chatStream.float.perf": "Cache & speed",
  "chatStream.float.cacheHit": "Cache hits",
  "chatStream.float.cacheHelp": "Cache hit rate = cache reads / (input + cache reads + cache writes). The average is token-weighted, not the mean of per-turn percentages.",
  "chatStream.float.speed": "Output speed",
  "chatStream.float.speedHelp": "Output speed = output tokens / generation time (only while text was streaming — tool runs and approval waits excluded). A turn that arrived in one chunk can't be measured and shows —.",
  "chatStream.float.thisTurn": "this turn",
  "chatStream.float.avg": "avg",
  "chatStream.float.perTurnCache": "Per turn",
  "chatStream.float.turnCache": "Turn {n} · {pct}",
  "chatStream.float.usage": "Usage",
  "chatStream.float.context": "Context",
  "chatStream.float.sessionTokens": "Session tokens",
  "chatStream.float.toolCalls": "Tool calls",
  "chatStream.float.toolCallsOk": "{n}",
  "chatStream.float.toolCallsVal": "{n} · {failed} failed",
  "chatStream.float.fileChanges": "File changes",
  "chatStream.float.cost": "Est. cost",
  "chatStream.metrics.aria": "This session · click for details",
  "chatStream.metrics.context": "Context {used} / {max}",
  "chatStream.metrics.cache": "Cache hits: session avg {avg} · this turn {turn}",
  "chatStream.metrics.speed": "Output speed: session avg {avg} tok/s · this turn {turn} tok/s",
  "chatStream.byline.cache": "cache {pct}",
  "chatStream.byline.speed": "{n} tok/s",
  "chatStream.byline.cacheHint": "This turn's cache hit rate = cache reads / (input + cache reads + cache writes)",
  "chatStream.byline.speedHint": "This turn emitted {tokens} tokens in {secs}s of generation (tool runs and approval waits excluded)",
  "chatStream.image.loading": "Reading image…",
  "chatStream.image.missing": "File not found",
  "chatStream.image.openInEditor": "Open in editor",
  "chatStream.image.reveal": "Show in folder",
  "chatStream.image.copy": "Copy image",
  "chatStream.image.attach": "Attach to the next message",
  "chatStream.image.zoom": "Click to enlarge",
  "chatStream.image.remote": "Web image",
  "chatStream.image.loadRemote": "Load image",
  "chatStream.image.loadFailed": "Couldn't load",
  "chatStream.image.retry": "Retry",
  "chatStream.fileChip.hint": "Click to select · double-click to open",
  "chatStream.fileChip.open": "Open",
  "chatStream.fileChip.reveal": "Show in folder",
  "chatStream.fileChip.copyPath": "Copy path",
  "chatStream.fileChip.copied": "Copied",
  "chatStream.fileChip.folder": "Folder",
  "chatStream.fileChip.image": "Image",
  "chatStream.fileChip.file": "File",
  "chatStream.fileChip.line": "Line {n}",
  "chatStream.activity.cluster.running": "{n} subagents running",
  "chatStream.activity.cluster.failed": "{n} subagents failed",
  "chatStream.activity.cluster.waiting": "Waiting for your answer",
  "chatStream.activity.cluster.tasks": "Tasks {done}/{total}",
  "chatStream.activity.cluster.plans": "{n} plans",
  "chatStream.activity.cluster.noPlans": "No plans",
  "chatStream.activity.cluster.openPlans": "Open plans",
  // Node names (console header / node tab strip)
  "chatStream.activity.node.tasks": "Tasks",
  "chatStream.activity.node.subagents": "Subagents",
  "chatStream.activity.node.plans": "Plans",
  "chatStream.activity.node.bookmarks": "Bookmarks",
  // Group headers and filter chips
  "chatStream.activity.groupRunning": "Running",
  "chatStream.activity.groupSettled": "Settled",
  "chatStream.activity.groupCompleted": "Completed",
  "chatStream.activity.groupFailed": "Failed",
  "chatStream.activity.groupInProgress": "In progress",
  "chatStream.activity.groupPending": "Pending",
  "chatStream.activity.groupToday": "Today",
  "chatStream.activity.groupEarlier": "Earlier",
  "chatStream.activity.groupStale": "Stale",
  // Subagents panel
  "chatStream.activity.subagentsSubRunning": "{running} running · {ended} settled",
  "chatStream.activity.subagentsSubIdle": "{n} · all settled",
  "chatStream.activity.unitAgents": "total",
  "chatStream.activity.labelRunning": "running",
  "chatStream.activity.labelCumulative": "total",
  "chatStream.activity.subagentsFooter": "Bars are each agent's real span; running ones reach “now”",
  "chatStream.activity.noDescription": "(no description)",
  "chatStream.activity.viewSubagent": "View subagent transcript",
  // Tasks panel
  "chatStream.activity.tasksSubtitle": "{done}/{total} done · {rest} left",
  "chatStream.activity.tasksDoneSuffix": "done",
  "chatStream.activity.tasksRest": "{n} left",
  "chatStream.activity.tasksFooter": "This node hides itself once every task is done",
  "chatStream.activity.priorityHigh": "High",
  "chatStream.activity.priorityMedium": "Med",
  "chatStream.activity.priorityLow": "Low",
  // Plans panel
  "chatStream.activity.plansSubtitle": "{n} plans, newest first",
  "chatStream.activity.unitPlans": "plans",
  "chatStream.activity.latestChip": "Latest",
  "chatStream.activity.openPlan": "Open",
  "chatStream.activity.plansFooter": "Click any plan to open it in the plan panel",
  "chatStream.activity.planFallback": "(Plan {n})",
  "chatStream.activity.viewPlan": "Click to view the full plan",
  // Bookmarks panel
  "chatStream.activity.bookmarksSub": "{n} bookmarks",
  "chatStream.activity.bookmarksSubStale": "{n} · {stale} stale",
  "chatStream.activity.unitBookmarks": "total",
  "chatStream.activity.bookmarksFooter": "Select text to add one; stale bookmarks are dimmed, never deleted",
  "chatStream.subagent.statusRunning": "Running",
  "chatStream.subagent.statusCompleted": "Completed",
  "chatStream.subagent.statusFailed": "Failed",
  "chatStream.subagent.statusKilled": "Terminated",

  // ── Message bookmarks (selection toolbar / capsule / timeline) ──
  "chatStream.bookmark.add": "Add bookmark",
  "chatStream.bookmark.askSideChat": "Send to sub-session",
  "chatStream.bookmark.copied": "Copied",
  "chatStream.bookmark.capsuleTitle": "Bookmarks ({n})",
  "chatStream.bookmark.sectionTitle": "Bookmarks · {n}",
  "chatStream.bookmark.jumpTitle": "Click to jump to the message",
  "chatStream.bookmark.remove": "Remove bookmark",
  "chatStream.bookmark.rename": "Rename bookmark",
  "chatStream.bookmark.renamePlaceholder": "Bookmark name",
  "chatStream.bookmark.stale": "Message removed",
  "chatStream.bookmark.addedToast": "Bookmark added",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "Upstream connection issue — retrying ({attempt}/{attempts})",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "Task ended early",
  "chatStream.turnIncomplete.danglingDesc":
    "The model channel returned an empty response mid-task, so this turn ended unfinished. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.emptyDesc":
    "The model channel returned no reply text this turn. Try resending or switching models.",
  "chatStream.turnIncomplete.unfinishedDesc":
    "The model's final text stops mid-sentence — the next step it announced never ran. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.pendingTools": "Unfinished calls: {tools}",

  // ── MessageBlocks: ExitPlanMode approval-channel failure ──
  "chatStream.planApprovalBroken.title": "Plan approval prompt failed to show",
  "chatStream.planApprovalBroken.desc":
    "The approval request broke in transit (not a user rejection). The plan is usually saved to the plan file — reply to approve it or request changes.",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "Start a new chat",
  "chatStream.welcome.withProject": "Start a new chat in {name}",
  "chatStream.welcome.todayUsage": "{turns} turns today · {tokens} tokens used",
} as const;
