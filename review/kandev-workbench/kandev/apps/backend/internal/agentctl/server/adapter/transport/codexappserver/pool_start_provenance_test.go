package codexappserver

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agentctl/server/adapter/transport/shared"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/kandev/kandev/internal/common/logger"
)

// @covers AC-TASKS-AGENT-POOL-002.2
func TestPoolProviderTurnStartedCarriesProvenance(t *testing.T) {
	adapter := NewAdapter(&shared.Config{}, logger.Default())
	t.Cleanup(func() { _ = adapter.Close() })
	adapter.threadID = "root-thread"
	adapter.activeGeneration = 42
	adapter.handleNotification(context.Background(), "turn/started",
		json.RawMessage(`{"threadId":"root-thread","turn":{"id":"provider-turn","status":"inProgress"}}`))
	select {
	case event := <-adapter.Updates():
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatal(err)
		}
		if event.Type != streams.EventTypeTurnStarted || event.OperationID != "provider-turn" ||
			event.PromptGeneration != 42 || wire["turn_start_source"] != "codex_provider_turn_started" {
			t.Fatalf("提供商开工事件缺少可区分的来源: %s", encoded)
		}
	case <-time.After(time.Second):
		t.Fatal("未收到提供商事件")
	}
	adapter.handleNotification(context.Background(), "turn/started",
		json.RawMessage(`{"threadId":"child-thread","turn":{"id":"child-turn","status":"inProgress"}}`))
	for {
		select {
		case event := <-adapter.Updates():
			if event.Type == streams.EventTypeTurnStarted {
				t.Fatalf("子代理事件不得冒充主轮次开工: %+v", event)
			}
		default:
			return
		}
	}
}
