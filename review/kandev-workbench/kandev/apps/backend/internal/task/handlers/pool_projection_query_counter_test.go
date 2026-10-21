package handlers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"path/filepath"
	"sync"
	"testing"

	"github.com/jmoiron/sqlx"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/require"
)

// 测量真实驱动的每次查询和执行，不向生产代码增加测试导出或查询接缝。
type poolProjectionQueryCounter struct {
	mu      sync.Mutex
	queries int
}

func (c *poolProjectionQueryCounter) record() {
	c.mu.Lock()
	c.queries++
	c.mu.Unlock()
}

func (c *poolProjectionQueryCounter) reset() {
	c.mu.Lock()
	c.queries = 0
	c.mu.Unlock()
}

func (c *poolProjectionQueryCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.queries
}

type poolProjectionCountingConnector struct {
	dsn     string
	counter *poolProjectionQueryCounter
}

func (c poolProjectionCountingConnector) Connect(ctx context.Context) (driver.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conn, err := (&sqlite3.SQLiteDriver{}).Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return &poolProjectionCountingConn{Conn: conn, counter: c.counter}, nil
}

func (poolProjectionCountingConnector) Driver() driver.Driver { return &sqlite3.SQLiteDriver{} }

type poolProjectionCountingConn struct {
	driver.Conn
	counter *poolProjectionQueryCounter
}

func (c *poolProjectionCountingConn) BeginTx(ctx context.Context, options driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, options)
}

func (c *poolProjectionCountingConn) Prepare(query string) (driver.Stmt, error) {
	stmt, err := c.Conn.Prepare(query)
	if err != nil {
		return nil, err
	}
	return &poolProjectionCountingStmt{Stmt: stmt, counter: c.counter}, nil
}

func (c *poolProjectionCountingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.counter.record()
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

func (c *poolProjectionCountingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.counter.record()
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}

type poolProjectionCountingStmt struct {
	driver.Stmt
	counter *poolProjectionQueryCounter
}

func (s *poolProjectionCountingStmt) Query(args []driver.Value) (driver.Rows, error) {
	s.counter.record()
	return s.Stmt.Query(args)
}

func (s *poolProjectionCountingStmt) Exec(args []driver.Value) (driver.Result, error) {
	s.counter.record()
	return s.Stmt.Exec(args)
}

func newPoolProjectionCountingReader(t *testing.T, f poolMoveWireFixture) (*tasksqlite.Repository, *poolProjectionQueryCounter) {
	t.Helper()
	var databasePath string
	require.NoError(t, f.database.Get(&databasePath, `SELECT file FROM pragma_database_list WHERE name='main'`))
	require.NotEmpty(t, databasePath)
	counter := &poolProjectionQueryCounter{}
	readDB := sqlx.NewDb(sql.OpenDB(poolProjectionCountingConnector{
		dsn: "file:" + filepath.ToSlash(databasePath) + "?mode=ro&_query_only=true&_busy_timeout=5000", counter: counter,
	}), "sqlite3")
	t.Cleanup(func() { require.NoError(t, readDB.Close()) })
	readDB.SetMaxOpenConns(1)
	var queryOnly int
	require.NoError(t, readDB.Get(&queryOnly, `PRAGMA query_only`))
	require.Equal(t, 1, queryOnly, "预算测量必须经过实际只读连接")
	repo, err := tasksqlite.NewWithDB(f.database, readDB, nil)
	require.NoError(t, err)
	return repo, counter
}
