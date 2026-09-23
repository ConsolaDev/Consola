import {
  WORKSPACE_ICON_IMAGE_SIZE, isWorkspaceImageIcon, type WorkspaceImageIcon,
} from '../../shared/workspaceIcons';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Keep the entire image (including transparency), fitting it inside a small square. */
export async function prepareWorkspaceIcon(file: File): Promise<WorkspaceImageIcon> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('Choose a PNG, JPG, WebP, or GIF image.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Choose an image smaller than 5 MB.');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be opened. Try another file.');
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = WORKSPACE_ICON_IMAGE_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the image. Please try again.');
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const icon: WorkspaceImageIcon = { type: 'image', dataUrl: canvas.toDataURL('image/png') };
    if (!isWorkspaceImageIcon(icon)) throw new Error('Could not prepare the image. Try another file.');
    return icon;
  } finally {
    bitmap.close();
  }
}
