import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';

const LANGUAGE_MAP = {
  'js': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  'jsx': () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  'ts': () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  'tsx': () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
  'mjs': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  'cjs': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  'json': () => import('@codemirror/lang-json').then(m => m.json()),
  'css': () => import('@codemirror/lang-css').then(m => m.css()),
  'html': () => import('@codemirror/lang-html').then(m => m.html()),
  'htm': () => import('@codemirror/lang-html').then(m => m.html()),
  'py': () => import('@codemirror/lang-python').then(m => m.python()),
  'java': () => import('@codemirror/lang-java').then(m => m.java()),
  'php': () => import('@codemirror/lang-php').then(m => m.php()),
  'cpp': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  'h': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  'hpp': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  'rs': () => import('@codemirror/lang-rust').then(m => m.rust()),
  'md': () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  'markdown': () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  'yaml': () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  'yml': () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  'xml': () => import('@codemirror/lang-xml').then(m => m.xml()),
  'sql': () => import('@codemirror/lang-sql').then(m => m.sql()),
};

export default function CodeMirrorEditor({ value, onChange, fileName, readOnly = false }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const [language, setLanguage] = useState(null);

  const getLanguage = () => {
    if (!fileName) return null;
    const ext = fileName.split('.').pop().toLowerCase();
    return LANGUAGE_MAP[ext] || null;
  };

  useEffect(() => {
    if (!editorRef.current) return;

    const loadLanguage = async () => {
      const languageLoader = getLanguage();
      let langExtension = null;

      if (languageLoader) {
        try {
          langExtension = await languageLoader();
        } catch (error) {
          console.error('Failed to load language extension:', error);
        }
      }

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

      if (langExtension) {
        extensions.push(langExtension);
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
      setLanguage(langExtension);
    };

    loadLanguage();

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
      }
    };
  }, [fileName]);

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

  return (
    <div
      ref={editorRef}
      className="w-full h-full border border-slate-700 rounded bg-slate-900/50 overflow-hidden"
      style={{ minHeight: '300px' }}
    />
  );
}