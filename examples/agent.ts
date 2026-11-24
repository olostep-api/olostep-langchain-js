// Run: OLOSTEP_API_KEY=... OPENAI_API_KEY=... npx tsx examples/agent.ts
// Needs: npm install langchain @langchain/openai
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';

import { createOlostepTools } from '../src/index.js';

const agent = createAgent({
  model: new ChatOpenAI({ model: 'gpt-5.4-mini' }),
  tools: createOlostepTools(),
});

const result = await agent.invoke({
  messages: [
    {
      role: 'user',
      content: 'Find the Olostep docs page about batches and summarise how many URLs one batch can hold. Cite the page.',
    },
  ],
});
console.log(result.messages.at(-1)?.content);
