/**
 * MediaStorageService
 *
 * Manages on-disk storage of media files attached to chat messages.
 * Each agent instance (session) has its own media directory.
 * Images are sequentially named per session ("Image 1", "Image 2", etc.).
 *
 * Storage layout: {userData}/media/{instanceId}/{attachmentId}.{ext}
 */

import { app, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { MediaAttachment, MediaAttachmentResult, MediaType } from '../shared/types';
import { SUPPORTED_IMAGE_TYPES, MAX_IMAGE_SIZE } from '../shared/constants';

// Per-instance image counters for sequential "Image 1", "Image 2" naming
const instanceCounters: Map<string, number> = new Map();

// Per-instance file tracking: instanceId -> Map<attachmentId, { filePath, attachment }>
const instanceFiles: Map<string, Map<string, { filePath: string; attachment: MediaAttachment }>> = new Map();

function getMediaBaseDir(): string {
    return path.join(app.getPath('userData'), 'media');
}

function getMediaDir(instanceId: string): string {
    return path.join(getMediaBaseDir(), instanceId);
}

function ensureMediaDir(instanceId: string): string {
    const dir = getMediaDir(instanceId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getNextCounter(instanceId: string): number {
    const current = instanceCounters.get(instanceId) ?? 0;
    const next = current + 1;
    instanceCounters.set(instanceId, next);
    return next;
}

function generateId(): string {
    return `media_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getMediaType(filePath: string): MediaType | null {
    const ext = path.extname(filePath).toLowerCase();
    return (SUPPORTED_IMAGE_TYPES[ext] as MediaType) ?? null;
}

function getExtFromMediaType(mediaType: MediaType): string {
    switch (mediaType) {
        case 'image/jpeg': return '.jpg';
        case 'image/png': return '.png';
        case 'image/gif': return '.gif';
        case 'image/webp': return '.webp';
        default: return '.png';
    }
}

/**
 * Generate a small thumbnail (max 200x200) from an image file.
 * Uses Electron's nativeImage — no extra dependencies.
 */
function generateThumbnail(filePath: string): { thumbnailBase64: string; width: number; height: number } {
    const image = nativeImage.createFromPath(filePath);

    if (image.isEmpty()) {
        throw new Error('Failed to load image: file may be corrupt or unsupported');
    }

    const size = image.getSize();
    const maxDim = 200;
    const scale = Math.min(maxDim / size.width, maxDim / size.height, 1);
    const resized = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
    });

    return {
        thumbnailBase64: resized.toPNG().toString('base64'),
        width: size.width,
        height: size.height,
    };
}

function getInstanceFiles(instanceId: string): Map<string, { filePath: string; attachment: MediaAttachment }> {
    let files = instanceFiles.get(instanceId);
    if (!files) {
        files = new Map();
        instanceFiles.set(instanceId, files);
    }
    return files;
}

/**
 * Add an image from a file path on disk.
 * Validates the file, copies it to the session media directory,
 * generates a thumbnail, and returns the attachment metadata.
 */
export async function addFromPath(instanceId: string, filePath: string): Promise<MediaAttachmentResult> {
    // Validate the file exists
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Validate file type
    const mediaType = getMediaType(filePath);
    if (!mediaType) {
        const ext = path.extname(filePath).toLowerCase();
        throw new Error(`Unsupported image type: ${ext}. Supported: .jpg, .jpeg, .png, .gif, .webp`);
    }

    // Validate file size
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_IMAGE_SIZE) {
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        throw new Error(`Image too large (${sizeMB}MB). Maximum size is ${MAX_IMAGE_SIZE / (1024 * 1024)}MB.`);
    }

    if (stats.size === 0) {
        throw new Error('Image file is empty');
    }

    // Generate IDs and naming
    const attachmentId = generateId();
    const counter = getNextCounter(instanceId);
    const displayName = `Image ${counter}`;
    const originalFilename = path.basename(filePath);
    const ext = getExtFromMediaType(mediaType);

    // Copy file to session media directory
    const mediaDir = ensureMediaDir(instanceId);
    const destPath = path.join(mediaDir, `${attachmentId}${ext}`);
    fs.copyFileSync(filePath, destPath);

    // Generate thumbnail and get dimensions
    const { thumbnailBase64, width, height } = generateThumbnail(destPath);

    const attachment: MediaAttachment = {
        id: attachmentId,
        displayName,
        originalFilename,
        mediaType,
        size: stats.size,
        width,
        height,
    };

    // Track the file
    const files = getInstanceFiles(instanceId);
    files.set(attachmentId, { filePath: destPath, attachment });

    return { attachment, thumbnailBase64 };
}

/**
 * Remove a specific attachment from disk and tracking.
 */
export async function remove(instanceId: string, attachmentId: string): Promise<void> {
    const files = getInstanceFiles(instanceId);
    const entry = files.get(attachmentId);

    if (entry) {
        // Delete the file from disk
        try {
            if (fs.existsSync(entry.filePath)) {
                fs.unlinkSync(entry.filePath);
            }
        } catch (err) {
            console.warn(`Failed to delete media file: ${entry.filePath}`, err);
        }
        files.delete(attachmentId);
    }
}

/**
 * Read an image file as base64 for sending to the Claude SDK.
 */
export async function getBase64(instanceId: string, attachmentId: string): Promise<{ data: string; mediaType: MediaType }> {
    const files = getInstanceFiles(instanceId);
    const entry = files.get(attachmentId);

    if (!entry) {
        throw new Error(`Attachment not found: ${attachmentId}`);
    }

    if (!fs.existsSync(entry.filePath)) {
        throw new Error(`Attachment file missing from disk: ${entry.filePath}`);
    }

    const buffer = fs.readFileSync(entry.filePath);
    return {
        data: buffer.toString('base64'),
        mediaType: entry.attachment.mediaType,
    };
}

/**
 * Clean up all media files for an instance (session).
 * Called when a session is deleted.
 */
export async function cleanupInstance(instanceId: string): Promise<void> {
    // Remove from tracking
    instanceFiles.delete(instanceId);
    instanceCounters.delete(instanceId);

    // Remove the directory from disk
    const dir = getMediaDir(instanceId);
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn(`Failed to clean up media directory: ${dir}`, err);
    }
}
