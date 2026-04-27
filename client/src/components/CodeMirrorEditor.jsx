import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { php } from '@codemirror/lang-php';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';

const LANGUAGE_MAP = {
  'js': javascript(),
  'jsx': javascript({ jsx: true }),
  'ts': javascript({ typescript: true }),
  'tsx': javascript({ jsx: true, typescript: true }),
  'mjs': javascript(),
  'cjs': javascript(),
  'json': json(),
  'css': css(),
  'html': html(),
  'htm': html(),
  'py': python(),
  'java': java(),
  'php': php(),
  'cpp': cpp(),
  'h': cpp(),
  'hpp': cpp(),
  'rs': rust(),
  'md': markdown(),
  'markdown': markdown(),
  'yaml': yaml(),
  'yml': yaml(),
  'xml': xml(),
  'sql': sql(),
};

export default function CodeMirrorEditor({ value, onChange, fileName, readOnly = false }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);

  const getLanguage = () => {
    if (!fileName) return null;
    const ext = fileName.split('.').pop().toLowerCase();
    return LANGUAGE_MAP[ext] || null;
  };

  useEffect(() => {
    if (!editorRef.current) return;

    const language = getLanguage();

    const extensions = [
      basicSetup,
      oneDark,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
      EditorState.readOnly.of(readOnly),
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '12px',
        },
        '.cm-scroller': {
          overflow: 'auto',
        },
        '.cm-content': {
          padding: '12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        },
      }),
    ];

    if (language) {
      extensions.push(language);
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, []);

  useEffect(() => {
    if (viewRef.current && value !== viewRef.current.state.doc.toString()) {
      const transaction = viewRef.current.state.update({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: value,
        },
      });
      viewRef.current.dispatch(transaction);
    }
  }, [value]);

  return <div ref={editorRef} className="w-full h-full border border-slate-700 rounded bg-slate-900/50" />;
}