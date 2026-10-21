package service_test

import (
	"context"
	"sync"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolTurnEndConcurrentReplayKeepsOneImmutableEvent(t *testing.T) {
	f, identity, activity := poolActivityFixture(t, "codex-app-server")
	activity.StartedSource = ""
	recorder := poolTurnEndRecorderFor(t, f.svc)
	const count = 12
	start := make(chan struct{})
	results := make(chan *runsmodels.RunEvent, count)
	errors := make(chan error, count)
	var joined sync.WaitGroup
	for range count {
		joined.Add(1)
		go func() {
			defer joined.Done()
			<-start
			event, err := recorder.ObservePoolTurnEnd(context.Background(), activity, false)
			results <- event
			errors <- err
		}()
	}
	close(start)
	joined.Wait()
	close(results)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	var first *runsmodels.RunEvent
	for event := range results {
		require.NotNil(t, event)
		if first == nil {
			first = event
		}
		require.Equal(t, first, event)
	}
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
	require.NoError(t, err)
	require.Len(t, events, 4)
}
