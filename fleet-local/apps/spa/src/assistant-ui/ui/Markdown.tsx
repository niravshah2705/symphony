import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  MarkdownTextPrimitive,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from './icons';

// The library's markdown answer: the same `.aui-md-*` class names its stylesheet
// paints, on MarkdownTextPrimitive from the current core. `unstable_` prefixes are
// gone in 0.14, and the smooth-streaming internals the vendored component used are
// private API, so the class names — not the vendored file — are what transfers.
const CodeHeader = ({ language, code }: CodeHeaderProps) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="aui-code-header-root">
      <span className="aui-code-header-language">{language}</span>
      <button
        type="button"
        className="aui-button aui-button-ghost aui-button-icon"
        aria-label="Copy code"
        title="Copy"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
};

const components = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => <h1 className={`aui-md-h1 ${className ?? ''}`} {...props} />,
  h2: ({ className, ...props }) => <h2 className={`aui-md-h2 ${className ?? ''}`} {...props} />,
  h3: ({ className, ...props }) => <h3 className={`aui-md-h3 ${className ?? ''}`} {...props} />,
  h4: ({ className, ...props }) => <h4 className={`aui-md-h4 ${className ?? ''}`} {...props} />,
  h5: ({ className, ...props }) => <h5 className={`aui-md-h5 ${className ?? ''}`} {...props} />,
  h6: ({ className, ...props }) => <h6 className={`aui-md-h6 ${className ?? ''}`} {...props} />,
  p: ({ className, ...props }) => <p className={`aui-md-p ${className ?? ''}`} {...props} />,
  a: ({ className, ...props }) => <a className={`aui-md-a ${className ?? ''}`} target="_blank" rel="noreferrer" {...props} />,
  blockquote: ({ className, ...props }) => <blockquote className={`aui-md-blockquote ${className ?? ''}`} {...props} />,
  ul: ({ className, ...props }) => <ul className={`aui-md-ul ${className ?? ''}`} {...props} />,
  ol: ({ className, ...props }) => <ol className={`aui-md-ol ${className ?? ''}`} {...props} />,
  hr: ({ className, ...props }) => <hr className={`aui-md-hr ${className ?? ''}`} {...props} />,
  table: ({ className, ...props }) => <table className={`aui-md-table ${className ?? ''}`} {...props} />,
  th: ({ className, ...props }) => <th className={`aui-md-th ${className ?? ''}`} {...props} />,
  td: ({ className, ...props }) => <td className={`aui-md-td ${className ?? ''}`} {...props} />,
  tr: ({ className, ...props }) => <tr className={`aui-md-tr ${className ?? ''}`} {...props} />,
  sup: ({ className, ...props }) => <sup className={`aui-md-sup ${className ?? ''}`} {...props} />,
  pre: ({ className, ...props }) => <pre className={`aui-md-pre ${className ?? ''}`} {...props} />,
  code: function Code({ className, ...props }) {
    // Inline spans get the chip class; a fenced block is styled by its `pre`.
    const isBlock = useIsMarkdownCodeBlock();
    return <code className={isBlock ? className : `aui-md-inline-code ${className ?? ''}`} {...props} />;
  },
  CodeHeader,
});

// `memo(…, () => true)` is what the library does: a streamed message re-renders on
// every token, and the primitive reads the part text from context itself.
const MarkdownTextImpl = () => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={components} defer />
);

export const MarkdownText = memo(MarkdownTextImpl, () => true);
