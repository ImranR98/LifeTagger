import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Face, FileDetail, FileSummary } from "@shared/types";

export function MediaViewer({
  file,
  faces,
  onFaceClick,
  showFaces = true,
}: {
  file: FileSummary | FileDetail;
  faces?: Face[];
  onFaceClick?: (face: Face) => void;
  showFaces?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
  }, [file.id]);
  return (
    <div className="media-frame">
      <div className="media-content">
        {file.kind === "video" ? (
          <video
            src={file.mediaUrl}
            poster={file.thumbUrl}
            controls
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <img src={file.previewUrl} alt={file.name} loading="eager" />
        )}
        {showFaces &&
          !(file.kind === "video" && playing) &&
          faces?.map((face) => (
            <button
              key={face.id}
              type="button"
              className="face-box"
              style={{
                left: `${face.bbox.x * 100}%`,
                top: `${face.bbox.y * 100}%`,
                width: `${face.bbox.w * 100}%`,
                height: `${face.bbox.h * 100}%`,
              }}
              onClick={() => onFaceClick?.(face)}
              title={face.label ?? "Unknown person"}
            >
              <span>{face.label ?? "Who is this?"}</span>
            </button>
          ))}
      </div>
      <a
        href={file.mediaUrl}
        target="_blank"
        rel="noreferrer"
        className="absolute right-3 top-3 rounded-lg border border-white/10 bg-black/55 p-2 text-white/80 backdrop-blur hover:text-white"
        title="Open original"
      >
        <ExternalLink size={14} />
      </a>
    </div>
  );
}
