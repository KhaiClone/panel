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
  const [selectedRow, setSelectedRow] = useState(null);
  const [showRowDetail, setShowRowDetail] = useState(false);

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
            // If not base64, check if it might be JSON or other text
            if (fileContent.trim().startsWith('{') || fileContent.trim().startsWith('[')) {
              throw new Error('File contains JSON data, not SQLite binary data');
            }
            throw new Error('Invalid SQLite file format - expected binary data');
          }
        } else if (fileContent instanceof Uint8Array) {
          uint8Array = fileContent;
        } else if (fileContent instanceof ArrayBuffer) {
          uint8Array = new Uint8Array(fileContent);
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

  const handleRowClick = (rowData) => {
    setSelectedRow(rowData);
    setShowRowDetail(true);
  };

  const formatValue = (value, columnName) => {
    if (value === null) return <span className="text-slate-500 italic">NULL</span>;
    if (value === undefined) return <span className="text-slate-500 italic">undefined</span>;

    // Try to detect and format JSON
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return (
          <pre className="text-xs bg-slate-950 p-2 rounded overflow-x-auto">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        );
      } catch (e) {
        // Not JSON, return as-is
        return <span className="text-slate-300">{String(value)}</span>;
      }
    }

    // Handle numbers
    if (typeof value === 'number') {
      return <span className="text-emerald-400">{value}</span>;
    }

    // Handle booleans
    if (typeof value === 'boolean') {
      return <span className={value ? "text-emerald-400" : "text-rose-400"}>{String(value)}</span>;
    }

    // Handle objects (including arrays)
    if (typeof value === 'object') {
      return (
        <pre className="text-xs bg-slate-950 p-2 rounded overflow-x-auto">
          {JSON.stringify(value, null, 2)}
        </pre>
      );
    }

    return <span className="text-slate-300">{String(value)}</span>;
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
              <tr
                key={rowIdx}
                className="border-b border-slate-800 hover:bg-slate-700/50 cursor-pointer transition-colors"
                onClick={() => handleRowClick(row)}
              >
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="px-3 py-2 text-slate-400 whitespace-nowrap">
                    {cell === null ? (
                      <span className="text-slate-600 italic">NULL</span>
                    ) : (
                      <span className="truncate max-w-[200px] block">
                        {typeof cell === 'object' ? '[Object]' : String(cell).substring(0, 50)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderRowDetail = () => {
    if (!selectedRow || !columns) return null;

    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-800">
            <h3 className="text-sm font-semibold text-slate-200">
              Row Details - {selectedTable}
            </h3>
            <button
              onClick={() => setShowRowDetail(false)}
              className="text-slate-400 hover:text-white transition-colors"
            >
              ✕
            </button>
          </div>
          <div className="p-4 overflow-y-auto max-h-[calc(80vh-60px)]">
            <div className="space-y-3">
              {columns.map((col, idx) => (
                <div key={idx} className="border border-slate-700 rounded-lg p-3 bg-slate-800/50">
                  <div className="text-xs font-semibold text-indigo-400 mb-2">
                    {col}
                  </div>
                  <div className="text-sm">
                    {formatValue(selectedRow[idx], col)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
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
    <div className="flex flex-col h-full border-2 border-slate-700 rounded-lg bg-slate-900/80 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-800/90 px-4 py-3 rounded-t-lg">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">📊 {fileName}</span>
          <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-1 rounded border border-slate-600">
            {tables.length} tables
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-3">
        <div className="flex h-full gap-3">
          {/* Table List */}
          <div className="w-48 flex-shrink-0 border border-slate-700 rounded-lg bg-slate-800/50 overflow-hidden">
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
                      : 'text-slate-400 hover:bg-slate-700'
                  }`}
                  onClick={() => handleTableSelect(table)}
                >
                  📋 {table}
                </button>
              ))}
            </div>
          </div>

          {/* Table Data */}
          <div className="flex-1 border border-slate-700 rounded-lg bg-slate-800/50 overflow-hidden">
            {selectedTable ? (
              <div className="h-full flex flex-col">
                <div className="p-2 border-b border-slate-700 bg-slate-800 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-400">
                    📄 {selectedTable} ({tableData.length} rows)
                  </h3>
                  <span className="text-xs text-slate-500">
                    Click on any row to view full details
                  </span>
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
      </div>

      {/* Row Detail Modal */}
      {showRowDetail && renderRowDetail()}
    </div>
  );
}