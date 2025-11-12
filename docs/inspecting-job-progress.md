# Inspecting Job Progress and Flow Status

This guide shows you how to inspect the progress and completion status of transaction polling jobs in the backend.

**Note:** All API endpoints are prefixed with `/api`. For example, `/flow/:id` should be accessed as `/api/flow/:id`.

## Available Endpoints

### 1. Get Flow Details
**Endpoint:** `GET /flow/:id`

Returns the complete flow information including chain progress, metadata, and status.

**Example:**
```bash
curl http://localhost:3000/api/flow/09cd432b-d5c8-49a7-a28d-71eaa4b87fc1
```

**Response:**
```json
{
  "data": {
    "id": "09cd432b-d5c8-49a7-a28d-71eaa4b87fc1",
    "txHash": "...",
    "flowType": "deposit",
    "status": "pending",
    "chainProgress": {
      "evm": {
        "status": "confirmed",
        "txHash": "...",
        "stages": [...]
      },
      "noble": {
        "status": "pending",
        "stages": [...]
      }
    },
    "metadata": {...},
    "createdAt": "2025-11-12T14:45:17.000Z",
    "updatedAt": "2025-11-12T14:45:18.000Z"
  }
}
```

### 2. Get Flow Status (Simplified)
**Endpoint:** `GET /flow/:id/status`

Returns only the flow ID, overall status, and chain progress.

**Example:**
```bash
curl http://localhost:3000/api/flow/09cd432b-d5c8-49a7-a28d-71eaa4b87fc1/status
```

**Response:**
```json
{
  "data": {
    "id": "09cd432b-d5c8-49a7-a28d-71eaa4b87fc1",
    "status": "pending",
    "chainProgress": {
      "evm": {...},
      "noble": {...},
      "namada": {...}
    }
  }
}
```

### 3. Get Status Logs
**Endpoint:** `GET /flow/:id/logs`

Returns all status log entries for the flow, showing the progression of status updates over time.

**Example:**
```bash
curl http://localhost:3000/api/flow/09cd432b-d5c8-49a7-a28d-71eaa4b87fc1/logs
```

**Response:**
```json
{
  "data": [
    {
      "id": "...",
      "status": "evm_burn_polling",
      "chain": "evm",
      "source": "poller",
      "detail": {
        "status": "pending",
        "blockNumber": "12345"
      },
      "createdAt": "2025-11-12T14:45:17.000Z"
    },
    {
      "id": "...",
      "status": "evm_burn_confirmed",
      "chain": "evm",
      "source": "poller",
      "detail": {
        "status": "confirmed",
        "txHash": "0x...",
        "blockNumber": "12346"
      },
      "createdAt": "2025-11-12T14:45:18.000Z"
    }
  ]
}
```

### 4. Get BullMQ Job Status
**Endpoint:** `GET /flow/:id/job`

Returns information about the BullMQ jobs associated with this flow, including job state, progress, and execution details.

**Example:**
```bash
curl http://localhost:3000/api/flow/09cd432b-d5c8-49a7-a28d-71eaa4b87fc1/job
```

**Response:**
```json
{
  "data": {
    "flowId": "09cd432b-d5c8-49a7-a28d-71eaa4b87fc1",
    "jobs": [
      {
        "id": "resume-09cd432b-d5c8-49a7-a28d-71eaa4b87fc1-1762958717023",
        "name": "flow-09cd432b-d5c8-49a7-a28d-71eaa4b87fc1",
        "state": "completed",
        "progress": null,
        "data": {
          "flowId": "09cd432b-d5c8-49a7-a28d-71eaa4b87fc1",
          "flowType": "deposit",
          "params": {...}
        },
        "timestamp": 1762958717023,
        "processedOn": 1762958718123,
        "finishedOn": 1762958718123,
        "failedReason": null,
        "attemptsMade": 1,
        "opts": {
          "attempts": 3,
          "backoff": {
            "type": "exponential",
            "delay": 2000
          }
        }
      }
    ],
    "activeJob": null,
    "latestJob": {
      "id": "resume-09cd432b-d5c8-49a7-a28d-71eaa4b87fc1-1762958717023",
      "state": "completed",
      ...
    }
  }
}
```

## Job States

BullMQ jobs can be in one of these states:
- **waiting**: Job is queued but not yet processed
- **active**: Job is currently being processed
- **completed**: Job finished successfully
- **failed**: Job failed (check `failedReason` for details)
- **delayed**: Job is scheduled for future execution

## Understanding Chain Progress

The `chainProgress` object tracks the status of each chain in the flow:

### Deposit Flow Progress
- **evm**: EVM burn transaction status
- **noble**: Noble CCTP mint and IBC forward status
- **namada**: Namada receive status

### Payment Flow Progress
- **namada**: Namada IBC send status
- **noble**: Noble receive and CCTP burn status
- **evm**: EVM mint status

Each chain entry contains:
- `status`: Current status (`pending`, `confirmed`, `failed`)
- `txHash`: Transaction hash (if available)
- `stages`: Array of stage updates with timestamps
- `lastCheckedAt`: Last time this chain was checked

## Monitoring a Flow

To monitor a flow's progress, you can:

1. **Check overall status:**
   ```bash
   curl http://localhost:3000/api/flow/{flowId}/status
   ```

2. **View detailed logs:**
   ```bash
   curl http://localhost:3000/api/flow/{flowId}/logs | jq '.data | sort_by(.createdAt)'
   ```

3. **Check job execution:**
   ```bash
   curl http://localhost:3000/api/flow/{flowId}/job | jq '.data.latestJob'
   ```

4. **Watch for updates** (poll every few seconds):
   ```bash
   watch -n 2 'curl -s http://localhost:3000/api/flow/{flowId}/status | jq .'
   ```

## Troubleshooting

### Job Stuck in "active" State
If a job is stuck in "active" state for too long:
1. Check the backend logs for errors
2. Verify the flow exists: `GET /api/flow/:id`
3. Check if the job is actually running or if the worker crashed

### Job Failed
If a job failed:
1. Check `failedReason` in the job response
2. Review status logs: `GET /api/flow/:id/logs`
3. Check `errorState` in the flow details: `GET /api/flow/:id`

### Flow Not Progressing
If a flow seems stuck:
1. Check `chainProgress` to see which chain is blocking
2. Review status logs to see the last update
3. Check if there are active jobs: `GET /api/flow/:id/job`
4. Verify the polling configuration and RPC endpoints are working

## Example: Complete Flow Inspection Script

```bash
#!/bin/bash

FLOW_ID="09cd432b-d5c8-49a7-a28d-71eaa4b87fc1"
BASE_URL="http://localhost:3000"

echo "=== Flow Status ==="
curl -s "$BASE_URL/api/flow/$FLOW_ID/status" | jq '.'

echo -e "\n=== Latest Status Logs ==="
curl -s "$BASE_URL/api/flow/$FLOW_ID/logs" | jq '.data | sort_by(.createdAt) | .[-5:]'

echo -e "\n=== Job Status ==="
curl -s "$BASE_URL/api/flow/$FLOW_ID/job" | jq '.data.latestJob'

echo -e "\n=== Chain Progress Summary ==="
curl -s "$BASE_URL/api/flow/$FLOW_ID/status" | jq '.data.chainProgress | to_entries | map({chain: .key, status: .value.status})'
```

Save this as `inspect-flow.sh`, make it executable, and run:
```bash
chmod +x inspect-flow.sh
./inspect-flow.sh
```

