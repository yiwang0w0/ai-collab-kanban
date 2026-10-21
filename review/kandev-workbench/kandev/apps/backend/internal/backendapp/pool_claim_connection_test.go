package backendapp

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/db"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
)

func poolQueueOnSecondConnection(t *testing.T, f poolRuntimeFixture) *runsservice.Service {
	t.Helper()
	var files []struct {
		Seq  int    `db:"seq"`
		Name string `db:"name"`
		File string `db:"file"`
	}
	if err := f.db.Select(&files, `PRAGMA database_list`); err != nil {
		t.Fatal(err)
	}
	path := ""
	for _, file := range files {
		if file.Name == "main" {
			path = file.File
		}
	}
	if path == "" {
		t.Fatal("多连接验收必须使用真实磁盘数据库，不能误用内存单连接夹具")
	}
	connection, err := db.OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	database := sqlx.NewDb(connection, "sqlite3")
	t.Cleanup(func() { _ = database.Close() })
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "console"})
	if err != nil {
		t.Fatal(err)
	}
	queue := runsservice.New(runssqlite.NewWithDB(database, database), nil, log, nil)
	queue.SetPoolReleaseSource(tasksqlite.NewWithInitializedDB(database, database, nil))
	queue.SetPoolEnqueueAdmission(&orchestrator.Service{})
	return queue
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.1
func TestPoolClaimStartAdmissionSerializesSeparateSQLiteConnections(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	request, err := f.claim.PoolStartRequest()
	if err != nil {
		t.Fatal(err)
	}
	queues := []*runsservice.Service{f.queue, poolQueueOnSecondConnection(t, f)}
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	t.Cleanup(func() { cancel(); workers.Wait() })
	start, results := make(chan struct{}), make(chan error, 12)
	for i := range 12 {
		workers.Add(1)
		go func(queue *runsservice.Service) {
			defer workers.Done()
			<-start
			results <- queue.AdmitPoolClaimStart(ctx, request)
		}(queues[i%len(queues)])
	}
	close(start)
	accepted := 0
	for range 12 {
		select {
		case err := <-results:
			if err == nil {
				accepted++
			} else if !errors.Is(err, runsmodels.ErrPoolLaunchAlreadyAdmitted) {
				t.Fatalf("连接竞争不能把旧快照或锁错误当成许可: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("多连接许可竞争未结束")
		}
	}
	if accepted != 1 {
		t.Fatalf("独立连接／协调器仍只能提交一个启动意图: %d", accepted)
	}
	var intents int
	if err := f.db.Get(&intents, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, f.claim.ID); err != nil || intents != 1 {
		t.Fatalf("持久意图必须保持唯一: count=%d err=%v", intents, err)
	}
}
