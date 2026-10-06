# Graph Report - coucou  (2026-10-06)

## Corpus Check
- 265 files · ~494,252 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 23 file(s) not represented in the graph (top: (none) 8, .css 5, .entitlements 2)

## Summary
- 2551 nodes · 5561 edges · 117 communities (86 shown, 31 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 124 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Learner Stats (Rust)
- Tutor Chat Protocol
- Fish Audio TTS/STT
- Upload Canvas (Swift)
- PC Control Tools
- Greeting Animation
- Skin Editor
- Gemini Provider
- Island Window & Sound
- Bot Canvas & Eyes
- Study Progress & Events
- Island Content Views
- Skin Bundles
- Claude Mascot Skin
- Settings & Bridge
- Bot Engine Animation
- Assistant & Attachments
- Island Layout Constants
- Ghost Bot & Panel
- Mini Bot Focus
- AppState & Cal.com
- Icons & Study Host
- AppState Settings
- Island Layout Types
- Hook Server
- Study App & Stats
- Windows Platform API
- Bot Drawing (CoreGraphics)
- Spec & Integration Docs
- Chat Bubble Views
- Tutor Tools (Rust)
- Integration Cards
- Linux Platform
- Skin Doc & Baking
- Settings View & Hooks
- Bot Layout & Glow
- Tauri Config
- Claude API Client
- DeepSeek Provider
- Markup & Kana Parsing
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 84
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 106
- Community 107
- Community 108
- Community 109
- Community 113
- Community 114
- Community 115
- Community 116

## God Nodes (most connected - your core abstractions)
1. `h()` - 86 edges
2. `AppState` - 62 edges
3. `HookServer` - 57 edges
4. `Island` - 52 edges
5. `IslandWindowController` - 49 edges
6. `BotEngine` - 46 edges
7. `Bridge` - 46 edges
8. `clear()` - 40 edges
9. `AgentTask` - 36 edges
10. `BotEngine` - 36 edges

## Surprising Connections (you probably didn't know these)
- `Greeting Animation Sequence` --conceptually_related_to--> `Mochi`  [INFERRED]
  design/animations/greeting-v2.html → README.md
- `File Upload Sequence Animation` --conceptually_related_to--> `Mochi`  [INFERRED]
  design/animations/upload-sequence.html → README.md
- `Study Panel` --shares_data_with--> `Island`  [INFERRED]
  windows/README.md → docs/SPEC.md
- `Kotoba` --shares_data_with--> `Mochi`  [INFERRED]
  windows/README.md → docs/SPEC.md
- `.body` --references--> `VercelDeployment`  [INFERRED]
  NotchBuddy/Sources/App/IslandViewContent.swift → NotchBuddy/Sources/App/AppState.swift

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-Platform Build System** — workflow_build_macos, workflow_windows, workflow_linux [EXTRACTED 1.00]
- **AI Provider Integration** — changelog_gemini_provider, changelog_openai_provider, readme_chat_features [EXTRACTED 1.00]
- **Mochi Animation Sequences** — design_greeting_animation, design_upload_animation, readme_mochi [INFERRED 0.85]
- **Integration Architecture** — docs_integrations_claude_code, docs_integrations_n8n, docs_integrations_file_handling, docs_agents_pill_catalog [EXTRACTED 1.00]
- **Character Personality System** — docs_spec_mochi, docs_spec_states, docs_spec_emotes, docs_spec_sounds [EXTRACTED 1.00]
- **Skin Customization and Rendering** — docs_skins_bundle_format, docs_skins_editor, docs_spec_mochi_rendering [INFERRED 0.85]

## Communities (117 total, 31 thin omitted)

### Community 0 - "Learner Stats (Rust)"
Cohesion: 0.06
Nodes (53): ACTIVITY_DAYS, blend_level(), Card, clamp01(), date_of(), Day, day_number(), DayStat (+45 more)

### Community 1 - "Tutor Chat Protocol"
Cohesion: 0.06
Nodes (45): boot(), BootInfo, BROWSER_ARGS, chat_reset(), chat_send(), Chats, create_window(), deepseek_models() (+37 more)

### Community 2 - "Fish Audio TTS/STT"
Cohesion: 0.05
Nodes (47): ASR_MODEL, BASE, body_has_voice_only_when_chosen_and_speed_in_range(), cache_dir(), cache_key(), cache_key_depends_on_every_input(), CACHE_LIMIT, clamp_speed() (+39 more)

### Community 3 - "Upload Canvas (Swift)"
Cohesion: 0.08
Nodes (30): .body, drawDocCG(), roundedRect(), UploadCanvasView, .body, .engine, usBodyPath(), UploadSequenceEngine (+22 more)

### Community 4 - "PC Control Tools"
Cohesion: 0.06
Nodes (46): apply(), every_declared_tool_is_handled(), MAX_QUERY, MAX_URL, NAMES, text(), tools(), web_url() (+38 more)

### Community 5 - "Greeting Animation"
Cohesion: 0.09
Nodes (37): drawGreeting(), drawHandL(), drawHandR(), drawHeader(), drawMinis(), drawMochi(), drawParticles(), gClamp() (+29 more)

### Community 6 - "Skin Editor"
Cohesion: 0.07
Nodes (52): hasPlainBackground(), removeBackground(), aboutBox, addPictures(), checkpoint(), clone(), colourBox, confirmDiscard() (+44 more)

### Community 7 - "Gemini Provider"
Cohesion: 0.07
Nodes (37): c, automatic_candidates(), BASE, body(), client(), DAILY_QUOTA, declarations(), declarations_omit_parameters_for_no_arg_tools() (+29 more)

### Community 8 - "Island Window & Sound"
Cohesion: 0.12
Nodes (4): Sound, Island, modeOrder(), main()

### Community 9 - "Bot Canvas & Eyes"
Cohesion: 0.07
Nodes (20): BotCanvasView, .body, BotPlacement, .body, botPosition(), Color, CountdownBar, .body (+12 more)

### Community 10 - "Study Progress & Events"
Cohesion: 0.09
Nodes (35): onEvent(), refreshStats(), ChatMessage, DEFAULT_SETTINGS, Listener, State, today(), BACKLOG (+27 more)

### Community 11 - "Island Content Views"
Cohesion: 0.09
Nodes (39): IslandContentView, .body, ApprovalInfo, AgentWho, .body, ApprovalView, .approval, CardBackground (+31 more)

### Community 12 - "Skin Bundles"
Cohesion: 0.09
Nodes (27): SkinInfo, BUNDLE_PREFIX, bundleId(), bundlePersona(), fillChar(), loadBundle(), readManifest(), HairSkin (+19 more)

### Community 13 - "Claude Mascot Skin"
Cohesion: 0.05
Nodes (41): idle, k, max, oy, sy, tilt, yaw, author (+33 more)

### Community 14 - "Settings & Bridge"
Cohesion: 0.16
Nodes (38): Bridge, binding(), KEY_ACTIONS, listBundles(), aiSection(), render(), CLAUDE_MODELS, generalSection() (+30 more)

### Community 15 - "Bot Engine Animation"
Cohesion: 0.12
Nodes (10): lerp(), BotEmoteName, BotEngine, heartPath(), mix3(), now(), rgba(), roundRectPath() (+2 more)

### Community 16 - "Assistant & Attachments"
Cohesion: 0.08
Nodes (16): Attachment, Chat, ChatReply, MAX_ROUNDS, obj(), Provider, Claude, DeepSeek (+8 more)

### Community 17 - "Island Layout Constants"
Cohesion: 0.10
Nodes (28): COMPACT_W, NOTCH_H, C0, CARD, clamp(), drawHandL(), drawHandR(), drawMinis() (+20 more)

### Community 18 - "Ghost Bot & Panel"
Cohesion: 0.10
Nodes (8): GhostBotView, .body, IslandPanel, .canBecomeKey, .canBecomeMain, islandSize(), IslandWindowController, .state

### Community 19 - "Mini Bot Focus"
Cohesion: 0.07
Nodes (28): .focusTask, MiniBotCanvasView, .body, CompactMiniGrid, .body, .others, AgentTask, PillBadge (+20 more)

### Community 20 - "AppState & Cal.com"
Cohesion: 0.10
Nodes (29): CalcomBooking, .dayKey, .isActive, .timeLabel, ChatMessage, ChatRole, assistant, user (+21 more)

### Community 21 - "Icons & Study Host"
Cohesion: 0.13
Nodes (21): Wash, washRGBA(), svg(), ICONS, buildStudyHost(), btn(), buildConfused(), buildHeader() (+13 more)

### Community 22 - "AppState Settings"
Cohesion: 0.07
Nodes (19): AppState, .absenceInterval, .activeChatModel, .activeIntegrations, .autoCloseInterval, .chatProvider, .claudeModel, .effectiveState (+11 more)

### Community 23 - "Island Layout Types"
Cohesion: 0.08
Nodes (28): AgentLayoutMode, column, grid, none, pills, IslandConst, IslandMode, compact (+20 more)

### Community 24 - "Hook Server"
Cohesion: 0.14
Nodes (7): HookServer, .agyHooksURL, .geminiSettingsURL, .hookScriptPath, .socketPath, .supportDir, settings

### Community 25 - "Study App & Stats"
Cohesion: 0.13
Nodes (26): Stats, buildStudyApp(), StudyContext, buildStats(), render(), weakList(), el(), fmtDate() (+18 more)

### Community 26 - "Windows Platform API"
Cohesion: 0.08
Nodes (14): CF_UNICODETEXT, clipboard_has_other_data(), clipboard_text(), CREATE_NO_WINDOW, CURSOR_POLL, HOME_VAR, key_down(), local_time() (+6 more)

### Community 27 - "Bot Drawing (CoreGraphics)"
Cohesion: 0.17
Nodes (11): CoreGraphics, cgColorToTuple(), clamp(), colorFromTuple(), Ease, heartShape(), lerp(), mix3() (+3 more)

### Community 28 - "Spec & Integration Docs"
Cohesion: 0.08
Nodes (5): Notch Buddy Prototype, Pill Catalog, Mochi, Notch Buddy, Kotoba

### Community 29 - "Chat Bubble Views"
Cohesion: 0.09
Nodes (23): ChatBubble, .body, ContextChip, .body, .label, IconButtonStyle, ModelPickerView, .body (+15 more)

### Community 30 - "Tutor Tools (Rust)"
Cohesion: 0.10
Nodes (27): ToolDef, apply(), assess_level_needs_a_score(), call(), described(), every_tool_has_an_object_schema(), FORMAT, items() (+19 more)

### Community 31 - "Integration Cards"
Cohesion: 0.08
Nodes (26): IntegrationCardView, .agentSessionActive, .body, .calcomHasData, .githubHasData, .n8nHasActivity, .notionHasData, .resendHasData (+18 more)

### Community 32 - "Linux Platform"
Cohesion: 0.08
Nodes (12): config_dir(), CURSOR_POLL, ensure_private_dir(), HOME_VAR, INPUT_REGION, LAYER_SURFACE, local_dir(), no_console() (+4 more)

### Community 33 - "Skin Doc & Baking"
Cohesion: 0.12
Nodes (28): Pt, addToPool(), bake(), Box, build(), emptyDoc(), exampleDoc(), Feel (+20 more)

### Community 34 - "Settings View & Hooks"
Cohesion: 0.12
Nodes (5): .openURL, SettingsView, .absenceMinutes, .body, .displayModels

### Community 35 - "Bot Layout & Glow"
Cohesion: 0.12
Nodes (21): botGlowColor(), botGlowOpacity(), BotPlacement, botPosition(), BotStateName, CHAT_EXPANDED, chatPromptHeight(), EXPANDED_CORNER (+13 more)

### Community 36 - "Tauri Config"
Cohesion: 0.07
Nodes (28): app, security, windows, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl (+20 more)

### Community 37 - "Claude API Client"
Cohesion: 0.11
Nodes (18): ChatContext, File, Window, ANTHROPIC_VERSION, base64(), base64_for(), call(), DEFAULT_MODEL (+10 more)

### Community 38 - "DeepSeek Provider"
Cohesion: 0.14
Nodes (19): BASE, body(), client(), DEFAULT_MODEL, each_tool_result_is_its_own_tool_message(), get(), MAX_TOKENS, ModelInfo (+11 more)

### Community 39 - "Markup & Kana Parsing"
Cohesion: 0.17
Nodes (23): nowPlaying(), Block, isKnown(), kanaOf(), parseReply(), plain(), plainJapanese(), romajiOf() (+15 more)

### Community 40 - "Community 40"
Cohesion: 0.24
Nodes (4): BotEngine, Particle, Tween, TweenKey

### Community 41 - "Community 41"
Cohesion: 0.15
Nodes (18): friendly(), MIN_MS, pickMime(), Recording, startRecording(), compare(), Comparison, lcs() (+10 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (16): CalcomBookingDetailView, .body, CalcomDetailRow, .body, ShimmerOverlay, .body, TickerRowView, .body (+8 more)

### Community 43 - "Community 43"
Cohesion: 0.19
Nodes (6): IslandStateMachine, State, coucou, hidden, home, petit

### Community 44 - "Community 44"
Cohesion: 0.17
Nodes (13): .body, CodeBlock, .body, MailField, .body, MailView, .body, PrimaryButton (+5 more)

### Community 45 - "Community 45"
Cohesion: 0.11
Nodes (7): clamp(), closeCurve, Ease, EaseFn, seg(), Spring, Tracked

### Community 46 - "Community 46"
Cohesion: 0.10
Nodes (18): BootInfo, Card, ChatKind, ChatReply, DayStat, Grade, HotkeyEvent, IS_TAURI (+10 more)

### Community 47 - "Community 47"
Cohesion: 0.19
Nodes (20): clip(), listen(), listeners, onVoiceChange(), play(), samples, setPlaying(), speak() (+12 more)

### Community 48 - "Community 48"
Cohesion: 0.21
Nodes (3): Doc, Handle, Stage

### Community 49 - "Community 49"
Cohesion: 0.16
Nodes (15): CalcomCalendarView, .allWeeks, .body, .navLabel, .visibleWeeks, CalcomCardView, .body, CalcomDayCell (+7 more)

### Community 52 - "Community 52"
Cohesion: 0.13
Nodes (16): ARM_L, ARM_R, BODY, C, chunk(), COVER, crc(), crcTable (+8 more)

### Community 53 - "Community 53"
Cohesion: 0.11
Nodes (17): Badge, BadgeKind, base, BASE_BOTTOM, BASE_TOP, BOT_STATES, BotStateCfg, C (+9 more)

### Community 54 - "Community 54"
Cohesion: 0.12
Nodes (4): DecorSkin, RibbonSkin, SkinName, Spring

### Community 55 - "Community 55"
Cohesion: 0.13
Nodes (10): AppKit, Combine, CryptoKit, Darwin, FileDropHandler, Notification.Name, Notification.Name, NotchBuddyApp (+2 more)

### Community 57 - "Community 57"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch (+9 more)

### Community 58 - "Community 58"
Cohesion: 0.15
Nodes (8): apply(), DEFAULT_ACCELERATOR, DEFAULT_LOOKUP, lookup(), LOOKUP_ID, parse(), plugin(), replace()

### Community 59 - "Community 59"
Cohesion: 0.12
Nodes (15): emoteEyeShape(), ParticleType, heart, spark, star, sweat, z, BotEmote (+7 more)

### Community 60 - "Community 60"
Cohesion: 0.18
Nodes (15): BASE_BOTTOM, BASE_TOP, chunk(), crc32(), CRC_TABLE, encodePNG(), files, ico (+7 more)

### Community 61 - "Community 61"
Cohesion: 0.12
Nodes (15): author, fit, centerX, eyeLine, height, width, format, id (+7 more)

### Community 63 - "Community 63"
Cohesion: 0.16
Nodes (9): CGColor, cgColorFromHex(), badgeString(), BadgeType, bang, dot, dots, question (+1 more)

### Community 64 - "Community 64"
Cohesion: 0.23
Nodes (6): fetchGoogleModels(), fetchModels(), fetchOpenAIModels(), Keychain, KeychainStore, Security

### Community 66 - "Community 66"
Cohesion: 0.12
Nodes (15): @fontsource-variable/inter, @tauri-apps/api, @tauri-apps/cli, typescript, dependencies, @fontsource-variable/inter, @tauri-apps/api, devDependencies (+7 more)

### Community 67 - "Community 67"
Cohesion: 0.13
Nodes (8): vite, bundleRoot, outDir, PACKAGES, root, { version }, written, SOUNDS_DIR

### Community 68 - "Community 68"
Cohesion: 0.18
Nodes (15): BARE_OK, capsOf(), comboFromEvent(), isBare(), isFKey(), KeyAction, keyName(), KeyScope (+7 more)

### Community 69 - "Community 69"
Cohesion: 0.15
Nodes (12): BOW, chunk(), crc(), crcTable, FRAME, HAIR, HAIR_DARK, HEAD (+4 more)

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (8): apply_input_region(), force_foreground(), gtk_window_ptr(), make_non_activating(), restore_foreground(), set_activating(), set_input_region(), show_without_focus()

### Community 71 - "Community 71"
Cohesion: 0.14
Nodes (11): Gemini Provider Support, Hook System for Agents, Keyboard Shortcut Customization, OpenAI Provider Support, Kotoba, Greeting Animation Sequence, File Upload Sequence Animation, Branding and Asset Rights (+3 more)

### Community 72 - "Community 72"
Cohesion: 0.14
Nodes (9): NotchBuddy, Bundle Identifiers, PillCategory, agent, ai, service, .title, workspace (+1 more)

### Community 73 - "Community 73"
Cohesion: 0.19
Nodes (8): AgentSource, agent, claudeCode, n8n, PillCatalog, .available, PillDefinition, .sessionSubtitle

### Community 74 - "Community 74"
Cohesion: 0.21
Nodes (9): force_foreground(), hwnd_of(), make_non_activating(), restore_foreground(), revoke_render_widget(), set_activating(), set_input_region(), show_without_focus() (+1 more)

### Community 75 - "Community 75"
Cohesion: 0.14
Nodes (14): EyeShape, closed, cup, dot, flat, happy, heart, line (+6 more)

### Community 76 - "Community 76"
Cohesion: 0.17
Nodes (3): Foundation, safeWebURL(), SafeWebURLTests

### Community 77 - "Community 77"
Cohesion: 0.15
Nodes (12): BotState, approval, dizzy, error, finished, idle, question, ratelimit (+4 more)

### Community 78 - "Community 78"
Cohesion: 0.21
Nodes (6): IntegrationFilterRow, .body, ShortcutRecorderButton, .body, .shortcutLabel, ServiceManagement

### Community 79 - "Community 79"
Cohesion: 0.15
Nodes (12): app, windows, bundleMediaFramework, bundle, linux, targets, depends, appimage (+4 more)

### Community 81 - "Community 81"
Cohesion: 0.22
Nodes (3): AVFoundation, SoundEngine, .volume

### Community 82 - "Community 82"
Cohesion: 0.20
Nodes (4): build(), sync(), TRAY_ID, TrayItems

### Community 86 - "Community 86"
Cohesion: 0.20
Nodes (8): ChatProvider, .accentHex, anthropic, .defaultModel, .displayName, google, .keychainKey, openai

### Community 89 - "Community 89"
Cohesion: 0.24
Nodes (3): SOUND_NAMES, SoundEngine, SoundName

### Community 90 - "Community 90"
Cohesion: 0.33
Nodes (7): clear(), entry(), get(), KNOWN_KEYS, present(), SERVICE, set()

### Community 92 - "Community 92"
Cohesion: 0.56
Nodes (9): buildSession(), finish(), frame(), grade(), progress(), render(), reveal(), start() (+1 more)

### Community 93 - "Community 93"
Cohesion: 0.25
Nodes (4): local_time(), system_summary(), home_dir(), LocalTime

### Community 94 - "Community 94"
Cohesion: 0.25
Nodes (8): Wash, amber, cyan, green, indigo, pink, red, soft

### Community 96 - "Community 96"
Cohesion: 0.25
Nodes (8): scripts, build, dev, icons, pack, preview, tauri, test

### Community 99 - "Community 99"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 101 - "Community 101"
Cohesion: 0.50
Nodes (4): GitHubStatsCardView, .body, StatRow, .body

## Knowledge Gaps
- **574 isolated node(s):** `.soundEnabled`, `.claudeModel`, `.chatProvider`, `.googleChatModel`, `.openAIChatModel` (+569 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 870 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **31 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Foundation` connect `Community 76` to `Community 64`, `Upload Canvas (Swift)`, `Greeting Animation`, `Community 103`, `Community 72`, `AppState & Cal.com`, `Island Layout Types`, `Community 84`, `Community 55`, `Community 88`, `Bot Drawing (CoreGraphics)`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `.soundEnabled`, `.claudeModel`, `.chatProvider` to the rest of the system?**
  _574 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Learner Stats (Rust)` be split into smaller, more focused modules?**
  _Cohesion score 0.05844155844155844 - nodes in this community are weakly interconnected._
- **Why does `SwiftUI` connect `Community 55` to `Upload Canvas (Swift)`, `Greeting Animation`, `Bot Canvas & Eyes`, `Community 78`, `AppState & Cal.com`, `Bot Drawing (CoreGraphics)`, `Chat Bubble Views`, `Community 63`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Should `Tutor Chat Protocol` be split into smaller, more focused modules?**
  _Cohesion score 0.060362173038229376 - nodes in this community are weakly interconnected._
- **Why does `SettingsView` connect `Settings View & Hooks` to `Community 64`, `Community 100`, `Island Content Views`, `Community 78`, `Community 55`, `Community 62`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Fish Audio TTS/STT` be split into smaller, more focused modules?**
  _Cohesion score 0.05487269534679543 - nodes in this community are weakly interconnected._