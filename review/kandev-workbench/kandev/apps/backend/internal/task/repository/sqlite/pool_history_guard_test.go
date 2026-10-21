package sqlite

import (
	"context"
	"testing"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/stretchr/testify/require"
)

func TestPoolHistoryRejectsPostgresBeforeDatabaseAccess(t *testing.T) {
	// 没有连接或 SQL 替身；移除方言门禁会直接暴露数据库依赖，不属于实际 PostgreSQL 验收。
	repository := &Repository{db: sqlx.NewDb(nil, dialect.PGX)}
	snapshot, err := repository.ReadPoolHistorySnapshot(context.Background(), "task", "workspace", poolhistory.Query{Limit: 50})
	require.ErrorIs(t, err, repoerrors.ErrPoolStorageUnsupported)
	require.Nil(t, snapshot)
}

func TestPoolHistoryRejectsUnboundedRepositoryInputBeforeDatabaseAccess(t *testing.T) {
	repository := &Repository{db: sqlx.NewDb(nil, dialect.SQLite3)}
	for _, query := range []poolhistory.Query{{Limit: 0}, {Limit: 51}, {Limit: 50, Before: -1}} {
		snapshot, err := repository.ReadPoolHistorySnapshot(t.Context(), "task", "workspace", query)
		require.ErrorIs(t, err, poolhistory.ErrInvalidQuery)
		require.Nil(t, snapshot)
	}
}
