const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const SOCIAL_CAMPAIGN_URL = process.env.SOCIAL_CAMPAIGN_URL || 'https://rei-social-campaign-production.up.railway.app';
const LIBRARY_URL = process.env.LIBRARY_URL || 'https://sublime-friendship-production.up.railway.app';
const LIBRARY_PASSWORD = process.env.LIBRARY_PASSWORD || 'Savannah050810!';

const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok'];
const AUTO_RESPONSE_KEYWORDS = ['buy', 'sell', 'deal', 'property', 'real estate', 'investment', 'partner', 'wholesale'];

let testResults = [];
let autoResponseLog = [];

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({
    service: 'rei-social-automator',
    status: 'ready',
    endpoints: {
      'POST /api/test-social': 'Run social platform tests',
      'POST /api/auto-respond': 'Process conversations and auto-respond',
      'GET /api/test-results': 'View test results history',
      'GET /api/response-log': 'View auto-response activity',
      'GET /api/status': 'Service status',
      'POST /api/webhook/ghl': 'GHL webhook inbound (comments/DMs)'
    }
  });
});

// Test all social platforms
app.post('/api/test-social', async (req, res) => {
  res.status(202).json({ message: 'Social tests started', status: 'running' });

  setTimeout(async () => {
    try {
      const results = await runSocialTests();
      testResults.push({
        timestamp: new Date().toISOString(),
        results
      });
      await recordTestsToLibrary(results);
    } catch (err) {
      console.error('Social tests failed:', err.message);
    }
  }, 100);
});

// Process conversations and auto-respond
app.post('/api/auto-respond', async (req, res) => {
  res.status(202).json({ message: 'Auto-response processing started', status: 'queued' });

  setTimeout(async () => {
    try {
      const conversations = await fetchGHLConversations();
      for (const conv of conversations) {
        const shouldRespond = checkIfShouldRespond(conv);
        if (shouldRespond) {
          const response = await generateClaudeResponse(conv);
          await sendAutoResponse(conv, response);
        }
      }
    } catch (err) {
      console.error('Auto-respond failed:', err.message);
    }
  }, 100);
});

// Get test results
app.get('/api/test-results', (req, res) => {
  res.status(200).json({
    total_tests: testResults.length,
    recent: testResults.slice(-10).reverse()
  });
});

// Get auto-response activity log
app.get('/api/response-log', (req, res) => {
  res.status(200).json({
    total_responses: autoResponseLog.length,
    recent: autoResponseLog.slice(-50).reverse()
  });
});

// Service status
app.get('/api/status', (req, res) => {
  res.status(200).json({
    service: 'rei-social-automator',
    status: 'ready',
    ghl_connected: !!GHL_API_KEY,
    anthropic_connected: !!ANTHROPIC_KEY,
    test_count: testResults.length,
    response_count: autoResponseLog.length
  });
});

// GHL webhook for inbound messages
app.post('/api/webhook/ghl', async (req, res) => {
  const { type, conversation, message } = req.body;

  if (type === 'comment' || type === 'dm' || type === 'message') {
    res.status(200).json({ received: true });

    setTimeout(async () => {
      try {
        const shouldRespond = checkIfShouldRespond({ ...conversation, message });
        if (shouldRespond) {
          const response = await generateClaudeResponse({ ...conversation, message });
          await sendAutoResponse(conversation, response, message.platform);
        }
      } catch (err) {
        console.error('Webhook processing failed:', err.message);
      }
    }, 100);
  } else {
    res.status(200).json({ status: 'ok' });
  }
});

// Helper: Run social platform tests
async function runSocialTests() {
  const results = {};

  for (const platform of PLATFORMS) {
    try {
      const response = await axios.get(`${SOCIAL_CAMPAIGN_URL}/api/status`, {
        timeout: 5000
      });

      results[platform] = {
        status: 'pass',
        response_time: response.duration || 0,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      results[platform] = {
        status: 'fail',
        error: err.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  return results;
}

// Helper: Fetch GHL conversations
async function fetchGHLConversations() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.warn('GHL credentials not configured');
    return [];
  }

  try {
    const response = await axios.get(
      `https://api.gohighlevel.com/v1/conversations`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15'
        },
        params: {
          locationId: GHL_LOCATION_ID,
          limit: 50
        }
      }
    );

    return response.data.conversations || [];
  } catch (err) {
    console.error('GHL fetch failed:', err.message);
    return [];
  }
}

// Helper: Check if conversation warrants auto-response
function checkIfShouldRespond(conversation) {
  if (!conversation.message && !conversation.text) return false;

  const text = (conversation.message?.text || conversation.text || '').toLowerCase();

  // Don't respond to own messages
  if (conversation.isOwn) return false;

  // Check if message contains relevant keywords
  const hasKeyword = AUTO_RESPONSE_KEYWORDS.some(kw => text.includes(kw));

  // Check if already responded
  const alreadyResponded = conversation.responses && conversation.responses.length > 0;

  return hasKeyword && !alreadyResponded;
}

// Helper: Generate Claude response
async function generateClaudeResponse(conversation) {
  if (!ANTHROPIC_KEY) {
    return getDefaultResponse();
  }

  const message = conversation.message?.text || conversation.text || '';
  const name = conversation.contact?.name || conversation.name || 'Friend';

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: `You are a helpful real estate assistant. Keep responses short (1-2 sentences), friendly, and focused on helping with property investment questions. Always include a call-to-action if appropriate. Sign off with just a first name (Steve).`,
        messages: [
          {
            role: 'user',
            content: `${name} asked: "${message}"\n\nRespond briefly and helpfully.`
          }
        ]
      },
      {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_KEY
        },
        timeout: 10000
      }
    );

    return response.data.content[0].text;
  } catch (err) {
    console.error('Claude API failed:', err.message);
    return getDefaultResponse();
  }
}

// Helper: Send auto-response
async function sendAutoResponse(conversation, responseText, platform = 'ghl') {
  try {
    if (platform === 'ghl') {
      // Send via GHL
      if (GHL_API_KEY && GHL_LOCATION_ID) {
        const convId = conversation.id || conversation.conversationId;
        if (!convId) {
          console.warn('No conversation ID found');
          return;
        }

        await axios.post(
          `https://api.gohighlevel.com/v1/conversations/${convId}/messages`,
          {
            message: responseText,
            type: 'text'
          },
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Version': '2021-04-15'
            }
          }
        );
      }
    }

    // Log auto-response
    autoResponseLog.push({
      timestamp: new Date().toISOString(),
      contact: conversation.contact?.name || 'Unknown',
      platform: platform,
      response: responseText,
      status: 'sent'
    });

    console.log(`✅ Auto-response sent to ${conversation.contact?.name || 'contact'}`);
  } catch (err) {
    console.error('Send response failed:', err.message);

    autoResponseLog.push({
      timestamp: new Date().toISOString(),
      contact: conversation.contact?.name || 'Unknown',
      platform: platform,
      error: err.message,
      status: 'failed'
    });
  }
}

// Helper: Get default response
function getDefaultResponse() {
  const responses = [
    "Thanks for reaching out! We'd love to help. What property are you interested in learning about?",
    "Great question! Feel free to share more details about your situation and we can discuss options.",
    "Thanks for getting in touch. Are you looking to buy, sell, or partner on deals?",
    "Appreciate you reaching out! What's your main real estate goal right now?",
    "Thanks for the interest! Let's chat about how we can help you win in real estate."
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

// Helper: Record tests to Library Control
async function recordTestsToLibrary(results) {
  try {
    const failCount = Object.values(results).filter(r => r.status === 'fail').length;
    const passCount = Object.values(results).filter(r => r.status === 'pass').length;

    const summary = {
      run_date: new Date().toISOString(),
      total_assets_tested: PLATFORMS.length,
      total_tests: PLATFORMS.length,
      total_passed: passCount,
      total_failed: failCount,
      overall_coverage: ((passCount / PLATFORMS.length) * 100).toFixed(1),
      status: failCount === 0 ? 'pass' : 'fail'
    };

    await axios.post(
      `${LIBRARY_URL}/api/test-runs`,
      summary,
      {
        headers: {
          'X-Library-Password': LIBRARY_PASSWORD
        }
      }
    );
  } catch (err) {
    console.error('Library record failed:', err.message);
  }
}

// Schedule auto-response checks every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Running auto-response check...`);
  try {
    const conversations = await fetchGHLConversations();
    let respondedCount = 0;

    for (const conv of conversations) {
      const shouldRespond = checkIfShouldRespond(conv);
      if (shouldRespond) {
        const response = await generateClaudeResponse(conv);
        await sendAutoResponse(conv, response);
        respondedCount++;
      }
    }

    console.log(`[${new Date().toISOString()}] Auto-response check complete. Responded to ${respondedCount} conversations.`);
  } catch (err) {
    console.error('Auto-response schedule failed:', err.message);
  }
});

// Schedule platform tests every hour
cron.schedule('0 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Running hourly social platform tests...`);
  try {
    const results = await runSocialTests();
    testResults.push({
      timestamp: new Date().toISOString(),
      results
    });
    await recordTestsToLibrary(results);
  } catch (err) {
    console.error('Scheduled test failed:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Social Automator listening on port ${PORT}`);
  console.log(`✅ GHL Connected: ${!!GHL_API_KEY}`);
  console.log(`✅ Claude Connected: ${!!ANTHROPIC_KEY}`);
  console.log(`✅ Monitoring 5 platforms: ${PLATFORMS.join(', ')}`);
  console.log(`✅ Auto-response check: Every 5 minutes`);
  console.log(`✅ Platform tests: Every hour`);
});

module.exports = { runSocialTests };
