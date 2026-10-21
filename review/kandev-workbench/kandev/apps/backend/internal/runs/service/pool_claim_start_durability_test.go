package service_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

func rebuiltPoolQueue(t *testing.T, f poolPublishFixture) *runsservice.Service {
	t.Helper()
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "console"})
	if err != nil {
		t.Fatal(err)
	}
	svc := runsservice.New(f.runs, nil, log, nil)
	svc.SetPoolReleaseSource(f.tasks)
	svc.SetPoolEnqueueAdmission(&orchestrator.Service{})
	return svc
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.1
func TestPoolClaimStartAdmissionSurvivesServiceRebuildAndConcurrentReplay(t *testing.T) {
	f, claim := claimedPoolFixture(t)
	request := poolClaimRequest(t, claim)
	instances := []*runsservice.Service{f.svc, rebuiltPoolQueue(t, f)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	start := make(chan struct{})
	results := make(chan error, 12)
	var workers sync.WaitGroup
	for i := range 12 {
		workers.Add(1)
		go func(svc *runsservice.Service) {
			defer workers.Done()
			<-start
			results <- svc.AdmitPoolClaimStart(ctx, request)
		}(instances[i%len(instances)])
	}
	t.Cleanup(func() { cancel(); workers.Wait() })
	close(start)
	accepted := 0
	for range 12 {
		select {
		case err := <-results:
			if err == nil {
				accepted++
			} else if !errors.Is(err, runsmodels.ErrPoolLaunchAlreadyAdmitted) {
				t.Fatalf("竞争不能改成其他启动授权或不明 SQL 结果: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("启动准入竞争未结束")
		}
	}
	if accepted != 1 {
		t.Fatalf("同一持久 claim 只能签发一次启动: %d", accepted)
	}
	if err := rebuiltPoolQueue(t, f).AdmitPoolClaimStart(ctx, request); !errors.Is(err, runsmodels.ErrPoolLaunchAlreadyAdmitted) {
		t.Fatalf("重建服务不能丢失持久启动意图: %v", err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, claim.ID); err != nil || count != 1 {
		t.Fatalf("所有竞争仍只保留一份原生意图: count=%d err=%v", count, err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.1
func TestPoolClaimStartAdmissionWriteFailureRollsBackPermit(t *testing.T) {
	f, claim := claimedPoolFixture(t)
	request := poolClaimRequest(t, claim)
	poolClaimFixtureSQL(t, f, `CREATE TRIGGER reject_pool_launch BEFORE INSERT ON run_events
		WHEN NEW.event_type = 'pool.launch-admitted.v1' BEGIN SELECT RAISE(ABORT, 'launch-admission-test-failure'); END`)
	if err := f.svc.AdmitPoolClaimStart(context.Background(), request); err == nil {
		t.Fatal("意图没有提交时不能签发启动成功")
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, claim.ID); err != nil || count != 0 {
		t.Fatalf("失败事务不能留下部分许可: count=%d err=%v", count, err)
	}
	poolClaimFixtureSQL(t, f, `DROP TRIGGER reject_pool_launch`)
	if err := f.svc.AdmitPoolClaimStart(context.Background(), request); err != nil {
		t.Fatalf("确认纯数据库写失败回滚后，首次许可仍应可提交: %v", err)
	}
}
