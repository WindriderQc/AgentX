const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');
const Workspace = require('./models/Workspace');
require('dotenv').config();

async function check() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
        console.log('Connected to DB');

        console.log('--- Last 5 Conversations ---');
        const convs = await Conversation.find().sort({_id: -1}).limit(5);
        if (convs.length === 0) {
            console.log('No conversations found.');
        } else {
            console.log(JSON.stringify(convs.map(c => ({
                id: c._id, 
                title: c.title, 
                workspaceId: c.workspaceId,
                errorMessage: c.messages.length > 0 && c.messages[c.messages.length-1].content.substring(0, 50) + '...'
            })), null, 2));
        }
        
        console.log('\n--- All Workspaces ---');
        const workspaces = await Workspace.find();
        console.log(JSON.stringify(workspaces, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

check();