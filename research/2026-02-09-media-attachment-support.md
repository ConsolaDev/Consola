---
date: 2026-02-09T12:00:00-05:00
git_commit: af7180a
branch: main
repository: console-1
topic: "Media/Image Attachment Support for Chat Input"
tags: [research, codebase, media, images, attachments, chat-input, sdk]
status: complete
---

# Research: Media/Image Attachment Support for Chat Input

**Date**: 2026-02-09
**Git Commit**: af7180a
**Branch**: main
**Repository**: console-1

## Research Question

How can we add support for images/media into the application so users can drag-and-drop media files onto the chat input, see previews, have them sequentially named per session, scoped to the current session, and cleaned up when sessions are deleted?

## Summary

The codebase is well-structured for adding media attachment support. The Claude Agent SDK **fully supports images** through its `MessageParam` type, which accepts content blocks including `image` blocks with base64-encoded data. The current implementation only sends plain string prompts, but the SDK's `query()` function also accepts `AsyncIterable<SDKUserMessage>` which enables rich content. The existing `codeReferencesStore` pattern provides an excellent architectural model for a per-instance media attachments store.

## Detailed Findings

### 1. Claude Agent SDK Image Support

**The SDK query function** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1072-1075`) accepts:
```typescript
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

**SDKUserMessage** (`sdk.d.ts:1568-1576`) uses `MessageParam` from `@anthropic-ai/sdk/resources`, which supports:
- `TextBlockParam`: `{ type: "text", text: string }`
- `ImageBlockParam`: `{ type: "image", source: { type: "base64", data: string, media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } }`
- `DocumentBlockParam`: `{ type: "document", source: { type: "base64", data: string, media_type: "application/pdf" } }`

**Current usage** (`src/main/ClaudeAgentService.ts:411`):
```typescript
this.currentQuery = sdk.query({ prompt: options.prompt, options: sdkOptions });
```
Only sends a plain string. Needs to be extended to support structured content blocks.

### 2. Current Chat Input Architecture

**ChatInput component** (`src/renderer/components/Agent/ChatInput/ChatInput.tsx`):
- Already has a placeholder `handleAttach` callback (line 58-61, with `// TODO: Implement file attachment`)
- Already passes `onAttach` to `InputToolbar` component
- Already has an `AttachButton` (Plus icon) in `InputToolbar.tsx:86-96`
- Already shows `CodeReferencesContainer` above the input area (line 76) - this is the exact pattern we need for media previews

**Message flow**:
1. `ChatInput.onSend` → wraps with code references → `useChatInput.handleSend`
2. `AgentPanel.sendMessage` → `useAgent.sendMessage`
3. `agentStore.sendMessage` → `agentBridge.startQuery(options)` with `prompt: string`
4. IPC `AGENT_START` → `ClaudeAgentService.startQuery` → `sdk.query({ prompt })`

### 3. Existing Code References Pattern (Model for Attachments)

**codeReferencesStore** (`src/renderer/stores/codeReferencesStore.ts`):
- Uses per-instance `Map<string, CodeReference[]>` pattern
- `addReference(instanceId, reference)` - adds to instance
- `removeReference(instanceId, referenceId)` - removes specific item
- `clearReferences(instanceId)` - clears all for instance
- `consumeReferences(instanceId)` - get and clear (for sending)
- `formatReferencesForMessage(references)` - converts to prompt text

**CodeReferencesContainer** (`src/renderer/components/CodeSelection/CodeReferencesContainer.tsx`):
- Shows pills above the input area inside `.chat-input-card`
- Each pill shows file info + remove button
- Integrated in `ChatInput.tsx` line 76

### 4. Session Management & Cleanup

**Session deletion flow** (`src/renderer/components/Sidebar/SessionNavItem.tsx:63-77`):
1. `destroyInstance(session.instanceId)` - destroys agent service
2. `sessionStorageBridge.deleteHistory(session.instanceId)` - deletes from SQLite
3. `deleteSession(workspaceId, session.id)` - removes from Zustand/localStorage
4. Clears active session if it was selected

**Database cascade** (`src/main/database/SessionDatabase.ts:251-256`):
- Deletes tool_executions, messages, then session record
- Media files on disk would need explicit cleanup in this flow

### 5. File System & IPC Infrastructure

**Preload API** (`src/preload/preload.ts`):
- `fileAPI.readFile(filePath)` - reads file as UTF-8 string
- `fileAPI.listDirectory(dirPath)` - lists directory contents
- No binary/base64 file reading currently

**IPC Handlers** (`src/main/ipc-handlers.ts`):
- `FILE_READ` (line 283) - reads files as UTF-8
- No handler for binary file reading or base64 encoding

**No drag-and-drop handling** exists anywhere in the codebase currently.

### 6. IPC Channel Constants

**`src/shared/constants.ts`**: All IPC channels defined here. New media channels need to be added:
- `MEDIA_SAVE` - Save dropped file to session media directory
- `MEDIA_READ` - Read media file as base64
- `MEDIA_DELETE` - Delete specific media file
- `MEDIA_CLEANUP` - Clean up all media for a session

### 7. Type System

**AgentQueryOptions** (`src/shared/types.ts:179-187`):
```typescript
export interface AgentQueryOptions {
    instanceId: string;
    cwd?: string;
    additionalDirectories?: string[];
    prompt: string;  // ← Needs to support structured content
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
}
```

## Architecture Documentation

### Required Changes Summary

| Layer | File | Change |
|-------|------|--------|
| **Types** | `src/shared/types.ts` | Add `MediaAttachment` type, extend `AgentQueryOptions` with `images` field |
| **Constants** | `src/shared/constants.ts` | Add `MEDIA_*` IPC channels |
| **Store** | New: `src/renderer/stores/mediaAttachmentsStore.ts` | Per-instance media attachment state (modeled after codeReferencesStore) |
| **Component** | New: `src/renderer/components/Agent/ChatInput/MediaAttachments/` | Preview strip, thumbnail, drop overlay |
| **Component** | `src/renderer/components/Agent/ChatInput/ChatInput.tsx` | Integrate drag-drop + media preview |
| **IPC** | `src/main/ipc-handlers.ts` | Add media file save/read/delete/cleanup handlers |
| **Preload** | `src/preload/preload.ts` | Expose `mediaAPI` to renderer |
| **Bridge** | New: `src/renderer/services/mediaBridge.ts` | Bridge for media operations |
| **Agent Service** | `src/main/ClaudeAgentService.ts` | Accept images in `startQuery`, build content blocks |
| **Agent Store** | `src/renderer/stores/agentStore.ts` | Pass images through `sendMessage` |
| **Session Cleanup** | `src/renderer/components/Sidebar/SessionNavItem.tsx` | Add media cleanup on session delete |

### Data Flow for Image Sending

```
User drags image → drop handler → mediaAPI.saveMedia() (IPC)
  → Main process saves to session media dir
  → Returns { id, path, base64, mimeType, caption }
  → mediaAttachmentsStore.addAttachment(instanceId, attachment)
  → UI shows preview strip above input

User sends message → consumeAttachments(instanceId)
  → agentStore.sendMessage(instanceId, cwd, prompt, { images })
  → agentBridge.startQuery({ ...options, images })
  → IPC AGENT_START
  → ClaudeAgentService builds SDK content blocks:
    [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", data, media_type } }]
  → sdk.query({ prompt: string_with_image_references, options })
```

### Media Storage Strategy

Session media stored at: `{userData}/media/{instanceId}/`
- Files named sequentially: `image-1.png`, `image-2.jpg`, etc.
- Counter tracked per session in the store
- Cleanup: delete entire directory on session delete

## Open Questions

1. **Max file size limit** - Should we enforce a limit? Claude API has ~20MB per image limit.
2. **Supported formats** - PNG, JPEG, GIF, WebP are supported by Claude. Should we support PDF documents too?
3. **Paste from clipboard** - Should Ctrl+V paste images from clipboard? (Enhancement for later)
4. **Image persistence** - Should attached-but-not-yet-sent images survive app restart? (Likely no - keep it simple)
