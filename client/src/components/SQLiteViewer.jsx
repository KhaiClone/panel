import { useState, useEffect, useRef } from 'react';
import initSqlJs from 'sql.js';

export default function SQLiteViewer({ fileContent, fileName }) {
  const [db, setDb] = useState(null);
  const [tables, setTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableData, setTableData] = useState([]);
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sqlQuery, setSqlQuery] = useState('');
  const [queryResult, setQueryResult] = useState(null);
  const [activeTab, setActiveTab] = useState('tables'); // 'tables' or 'query'

  const sqlJsRef = useRef(null);

  useEffect(() => {
    const initDatabase = async () => {
      try {
        setLoading(true);
        setError(null);

        // Initialize SQL.js
        if (!sqlJsRef.current) {
          const SQL = await initSqlJs({
            locateFile: file => `/sql-wasm.wasm`
          });
          sqlJsRef.current = SQL;
        }

        // Convert base64 or binary content to Uint8Array
        let uint8Array;
        if (typeof fileContent === 'string') {
          // Try to detect if it's base64
          try {
            const binaryString = atob(fileContent);
            uint8Array = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              uint8Array[i] = binaryString.charCodeAt(i);
            }
          } catch (e) {
            // If not base64, treat as text (this won't work for real SQLite files)
            throw new Error('Invalid SQLite file format');
          }
        } else if (fileContent instanceof Uint8Array) {
          uint8Array = fileContent;
        } else {
          throw new Error('Unsupported file format');
        }

        // Create database from file
        const database = new sqlJsRef.current.Database(uint8Array);
        setDb(database);

        // Get all tables
        const tablesResult = database.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        const tableNames = tablesResult.length > 0 ? tablesResult[0].values.map(row => row[0]) : [];
        setTables(tableNames);

        // Select first table by default
        if (tableNames.length > 0) {
          setSelectedTable(tableNames[0]);
          loadTableData(database, tableNames[0]);
        }

        setLoading(false);
      } catch (err) {
        console.error('Error loading SQLite database:', err);
        setError(err.message || 'Failed to load SQLite database');
        setLoading(false);
      }
    };

    if (fileContent) {
      initDatabase();
    }

    return () => {
      if (db) {
        db.close();
      }
    };
  }, [fileContent]);

  const loadTableData = (database, tableName) => {
    try {
      // Get table structure
      const pragmaResult = database.exec(`PRAGMA table_info(${tableName})`);
      const columnNames = pragmaResult.length > 0
        ? pragmaResult[0].values.map(row => row[1])
        : [];
      setColumns(columnNames);

      // Get table data
      const dataResult = database.exec(`SELECT * FROM ${tableName} LIMIT 100`);
      const data = dataResult.length > 0 ? dataResult[0].values : [];
      setTableData(data);
    } catch (err) {
      console.error('Error loading table data:', err);
      setError(err.message || 'Failed to load table data');
    }
  };

  const handleTableSelect = (tableName) => {
    setSelectedTable(tableName);
    loadTableData(db, tableName);
  };

  const executeQuery = () => {
    if (!db || !sqlQuery.trim()) return;

    try {
      const results = db.exec(sqlQuery);
      setQueryResult(results);
    } catch (err) {
      setError(err.message || 'Query execution failed');
    }
  };

  const renderTable = (data, cols) => {
    if (!data || data.length === 0) {
      return <div className="text-center text-slate-500 py-8">No data available</div>;
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-800 border-b border-slate-700">
              {cols.map((col, idx) => (
                <th key={idx} className="px-3 py-2 text-left font-semibold text-slate-300 whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-800 hover:bg-slate-800/50">
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="px-3 py-2 text-slate-400 whitespace-nowrap">
                    {cell === null ? <span className="text-slate-600 italic">NULL</span> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderQueryResult = () => {
    if (!queryResult || queryResult.length === 0) {
      return <div className="text-center text-slate-500 py-8">No results</div>;
    }

    return (
      <div className="space-y-4">
        {queryResult.map((result, idx) => (
          <div key={idx}>
            <h4 className="text-xs font-semibold text-slate-400 mb-2">Result {idx + 1}</h4>
            {renderTable(result.values, result.columns)}
          </div>
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-rose-400 text-lg mb-2">⚠️</div>
          <div className="text-rose-400 text-sm">{error}</div>
        </div>
      </div>
    );
  }

  if (!db) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-500 text-sm">No database loaded</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-700 pb-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">📊 {fileName}</span>
          <span className="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded">
            {tables.length} tables
          </span>
        </div>
        <div className="flex gap-2">
          <button
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              activeTab === 'tables'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
            onClick={() => setActiveTab('tables')}
          >
            Tables
          </button>
          <button
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              activeTab === 'query'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
            onClick={() => setActiveTab('query')}
          >
            SQL Query
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'tables' ? (
          <div className="flex h-full gap-4">
            {/* Table List */}
            <div className="w-48 flex-shrink-0 border border-slate-700 rounded bg-slate-900/50 overflow-hidden">
              <div className="p-2 border-b border-slate-700 bg-slate-800">
                <h3 className="text-xs font-semibold text-slate-400">Tables</h3>
              </div>
              <div className="overflow-y-auto max-h-full">
                {tables.map(table => (
                  <button
                    key={table}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                      selectedTable === table
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:bg-slate-800'
                    }`}
                    onClick={() => handleTableSelect(table)}
                  >
                    📋 {table}
                  </button>
                ))}
              </div>
            </div>

            {/* Table Data */}
            <div className="flex-1 border border-slate-700 rounded bg-slate-900/50 overflow-hidden">
              {selectedTable ? (
                <div className="h-full flex flex-col">
                  <div className="p-2 border-b border-slate-700 bg-slate-800">
                    <h3 className="text-xs font-semibold text-slate-400">
                      📄 {selectedTable} ({tableData.length} rows)
                    </h3>
                  </div>
                  <div className="flex-1 overflow-auto p-2">
                    {renderTable(tableData, columns)}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                  Select a table to view data
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col gap-3">
            {/* Query Input */}
            <div className="border border-slate-700 rounded bg-slate-900/50 overflow-hidden">
              <div className="p-2 border-b border-slate-700 bg-slate-800">
                <h3 className="text-xs font-semibold text-slate-400">SQL Query</h3>
              </div>
              <div className="p-2">
                <textarea
                  className="w-full h-24 bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-indigo-500"
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                  placeholder="SELECT * FROM table_name WHERE condition..."
                  spellCheck={false}
                />
                <button
                  className="mt-2 btn-primary text-xs py-1.5 px-4"
                  onClick={executeQuery}
                >
                  ▶ Execute Query
                </button>
              </div>
            </div>

            {/* Query Results */}
            <div className="flex-1 border border-slate-700 rounded bg-slate-900/50 overflow-hidden">
              <div className="p-2 border-b border-slate-700 bg-slate-800">
                <h3 className="text-xs font-semibold text-slate-400">Results</h3>
              </div>
              <div className="flex-1 overflow-auto p-2">
                {renderQueryResult()}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}