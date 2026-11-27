// Files in the transcript, both directions.
//
// Inbound (user → agent) the composer holds an Attachment whose content the AG-UI
// client serializes into the run input; the chips below are the human's check
// that the right file is about to be sent. Outbound (agent → user) the BFF turns
// an A2A FilePart into an AG-UI CUSTOM event, which react-ag-ui stores as a data
// part keyed by that event name — so `by_name` is the whole integration point.
//
// A data URL and a URI are the same thing to a browser tag, and both spellings
// occur: an inline artifact comes back as bytes, a fileserver reference as a URI.

import { useEffect, useState } from 'react';
import type { FC } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  type Attachment,
  type DataMessagePartProps,
  type FileMessagePartProps,
  type ImageMessagePartProps,
} from '@assistant-ui/react';
import { CloseIcon, PaperclipIcon } from './icons';

// Byte-identical to FILE_CUSTOM_EVENT in packages/shared/src/a2a/../agui.ts. The
// SPA spells the wire keys it matches on locally because the shared package
// exports .ts paths its tsconfig rejects (the same choice as FleetAgUiAgent.ts).
export const FILE_CUSTOM_EVENT = 'fleet.dev/file';

interface WireFile {
  dataUri?: string;
  uri?: string;
  mimeType?: string;
  name?: string;
}

const readValue = (value: unknown): WireFile => {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
  return { dataUri: str(v.dataUri), uri: str(v.uri), mimeType: str(v.mimeType), name: str(v.name) };
};

const label = (file: WireFile): string => file.name ?? file.uri?.split('/').pop() ?? 'attachment';

// An external URI is fetched by the browser, not by us; a data URI is already
// here. Either way the agent chose the content, so it renders as a link target
// rather than as trusted inline markup.
const AgentFile: FC<DataMessagePartProps> = ({ data }) => {
  const file = readValue(data);
  const src = file.dataUri ?? file.uri;
  if (!src) return null;
  const type = file.mimeType ?? '';
  const name = label(file);
  if (type.startsWith('image/')) {
    return (
      <a className="aui-file aui-file-image" href={src} target="_blank" rel="noreferrer">
        {/* The transcript is a column, not a gallery: the thumbnail is capped by
            CSS and the full bytes are one click away. */}
        <img className="aui-file-thumb" src={src} alt={name} loading="lazy" />
        <span className="aui-file-name">{name}</span>
      </a>
    );
  }
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    return type.startsWith('video/') ? (
      <video className="aui-file-media" src={src} controls preload="metadata" />
    ) : (
      <audio className="aui-file-media" src={src} controls preload="none" />
    );
  }
  return (
    <a className="aui-file aui-file-chip" href={src} target="_blank" rel="noreferrer" download={file.name}>
      <span className="aui-file-ext">{type.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</span>
      <span className="aui-file-name">{name}</span>
    </a>
  );
};

// The user's own upload, as it stays in the transcript after sending.
const UserImage: FC<ImageMessagePartProps> = ({ image, filename }) => (
  <img className="aui-file-thumb aui-file-thumb-user" src={image} alt={filename ?? 'attached image'} loading="lazy" />
);

const UserFile: FC<FileMessagePartProps> = ({ filename, mimeType, data }) => {
  const name = filename ?? 'attachment';
  const href = mimeType.startsWith('image/') && data.startsWith('data:') ? data : undefined;
  return (
    <span className="aui-file aui-file-chip">
      {href ? <img className="aui-file-thumb aui-file-thumb-small" src={href} alt={name} /> : null}
      <span className="aui-file-ext">{mimeType.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</span>
      <span className="aui-file-name">{name}</span>
    </span>
  );
};

// A File has no URL until one is made, and an object URL leaks until revoked —
// so the preview lives and dies with the chip.
const useObjectUrl = (file: File | undefined): string | undefined => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return;
    }
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return url;
};

const Chip: FC<{ attachment: Attachment }> = ({ attachment }) => {
  const image = attachment.type === 'image' ? attachment.file : undefined;
  const url = useObjectUrl(image);
  const mime = attachment.contentType ?? attachment.file?.type ?? '';
  return (
    <AttachmentPrimitive.Root className="aui-attachment">
      {url ? (
        <img className="aui-file-thumb aui-file-thumb-small" src={url} alt="" />
      ) : (
        <span className="aui-file-ext">{mime.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</span>
      )}
      <span className="aui-attachment-name">{attachment.name}</span>
      <AttachmentPrimitive.Remove asChild>
        <button type="button" className="aui-attachment-remove" aria-label={`Remove ${attachment.name}`}>
          <CloseIcon />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

const ComposerAttachments: FC = () => (
  <div className="aui-attachments-row">
    <ComposerPrimitive.Attachments>{({ attachment }) => <Chip attachment={attachment} />}</ComposerPrimitive.Attachments>
  </div>
);

const AddAttachment: FC<{ disabled: boolean }> = ({ disabled }) => (
  <ComposerPrimitive.AddAttachment
    className="aui-button aui-button-outline aui-button-icon aui-composer-attach"
    aria-label="Attach a file"
    title="Attach an image or document (max 5 MB)"
    disabled={disabled}
    multiple
  >
    {/* ComposerPrimitive.AddAttachment triggers the adapter's picker; the label is
        the accessible one above, so the icon alone is enough here. */}
    <PaperclipIcon />
  </ComposerPrimitive.AddAttachment>
);

export { AgentFile, UserImage, UserFile, ComposerAttachments, AddAttachment };
