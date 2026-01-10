const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');
const Workspace = require('./models/Workspace');
require('dotenv').config();

async function check() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
        console.log('Connected to DB');

        const convId = '6961f3249308562baea7fca3';
        // Note: The ID provided by the user log '6961f3249308562baea7fca3' is 24 chars hex?
        // Let's validity check it.
        // wait, 6961f3249308562baea7fca3 is 24 chars?
        // 6961f3249308562baea7fca3
        // 123456789012345678901234
        // Yes, it is.
        
        // Wait, '6961f3249308562baea7fca3' looks suspiciously generated or maybe typo?
        // Standard MongoIDs start with timestamp. 
        // 0x6961f324 = 1768026916 =>  Sunday, January 11, 2026? 
        // Today is Jan 10. So it's in the future? 
        // Ah, maybe the user has a slightly different clock or I'm miscalculating.
        
        let conv = null;
        try {
            conv = await Conversation.findById(convId);
        } catch(e) {
            console.log("Invalid ID format");
        }
        
        if (!conv) {
            console.log('Conversation NOT FOUND in DB:', convId);
             // Check if ANY conversation exists created recently
             const recent = await Conversation.findOne().sort({_id: -1});
             if(recent) {
                 console.log('Most recent conversation:', recent._id, recent.title);
             }
        } else {
            console.log('Conversation FOUND:');
            console.log('ID:', conv._id);
            console.log('WorkspaceId:', conv.workspaceId);
            console.log('Title:', conv.title);
        }

        const workspaceSlug = 'testing-workspace';
        const ws = await Workspace.findOne({ slug: workspaceSlug });
        if (ws) {
            console.log('Workspace FOUND:', ws.slug, ws._id);
            if (conv && conv.workspaceId) {
                console.log('Match?', conv.workspaceId.toString() === ws._id.toString());
            }
        } else {
            console.log('Workspace NOT FOUND:', workspaceSlug);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

check();