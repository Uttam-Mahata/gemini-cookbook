const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const winston = require('winston');
const { GoogleGenerativeAI } = require('@google/genai');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const axios = require('axios');

// Load environment variables
dotenv.config();

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const upload = multer({
  dest: 'temp/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Initialize Google GenAI client
let genaiClient;
try {
  genaiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  logger.info('Google GenAI client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Google GenAI client:', error);
}

// Global storage for task progress and generated videos
const taskProgress = new Map();
const generatedVideos = new Map();

// Helper functions
function updateProgress(taskId, status, progress, message, step) {
  taskProgress.set(taskId, {
    status,
    progress,
    message,
    currentStep: step,
    updatedAt: Date.now()
  });
  logger.info(`Task ${taskId}: ${progress}% - ${message}`);
}

async function generateStructuredStory(theme, sceneCount, characterDescription) {
  try {
    const model = genaiClient.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Create an engaging ${sceneCount}-scene story with the theme: "${theme}"
    
    ${characterDescription ? `Main character description: ${characterDescription}` : ''}
    
    Requirements:
    - Create 1-3 consistent characters that appear throughout the story
    - Each scene should have clear visual descriptions suitable for image generation
    - Include narration text for each scene
    - Maintain character consistency across scenes
    - Make the story cohesive and engaging
    - Suitable for animated video format
    
    Return the response as a JSON object with this structure:
    {
      "title": "Story Title",
      "characters": [
        {
          "name": "Character Name",
          "description": "Character description",
          "appearance": "Visual appearance description"
        }
      ],
      "scenes": [
        {
          "scene_number": 1,
          "description": "Scene description",
          "narration": "Narration text",
          "visual_description": "Detailed visual description for image generation",
          "characters_present": ["Character Name"]
        }
      ]
    }`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Try to parse JSON from response
    let jsonStart = text.indexOf('{');
    let jsonEnd = text.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd === 0) {
      throw new Error('No valid JSON found in response');
    }
    
    const jsonText = text.substring(jsonStart, jsonEnd);
    return JSON.parse(jsonText);
    
  } catch (error) {
    logger.error('Error generating story:', error);
    throw new Error(`Failed to generate story: ${error.message}`);
  }
}

async function generateSceneImage(scene, characters) {
  try {
    // Build character context for consistent appearance
    let characterContext = '';
    if (scene.characters_present && characters) {
      const presentChars = characters.filter(c => 
        scene.characters_present.includes(c.name)
      );
      if (presentChars.length > 0) {
        const charDescriptions = presentChars.map(c => 
          `${c.name}: ${c.appearance}`
        );
        characterContext = `Characters in scene: ${charDescriptions.join(', ')}. `;
      }
    }

    // Create detailed image prompt
    const imagePrompt = `High-quality animated style illustration. ${characterContext}${scene.visual_description}. 
    Style: colorful, friendly animated movie style, detailed background, good lighting, cinematic composition.`;

    const model = genaiClient.getGenerativeModel({ model: 'imagen-3.0-fast-generate-001' });
    
    const result = await model.generateContent([
      {
        text: imagePrompt
      }
    ]);

    const response = await result.response;
    
    // Extract image data (this is a simplified implementation)
    // In actual implementation, you would handle the image response properly
    
    // For now, create a placeholder colored image using Sharp
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    
    const imageBuffer = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: color
      }
    })
    .png()
    .toBuffer();

    return imageBuffer;
    
  } catch (error) {
    logger.error('Error generating image:', error);
    
    // Return placeholder image
    const imageBuffer = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: '#lightblue'
      }
    })
    .png()
    .toBuffer();
    
    return imageBuffer;
  }
}

async function generateSceneAudio(narration) {
  try {
    // Note: This is a simplified implementation
    // In production, you would use the actual Gemini Live API for audio synthesis
    
    // For now, create a silent audio file as placeholder
    const duration = Math.max(3.0, narration.length * 0.1); // Rough estimation
    
    return new Promise((resolve, reject) => {
      const outputPath = `temp/audio_${Date.now()}.wav`;
      
      // Create silent audio using ffmpeg
      ffmpeg()
        .input('anullsrc=channel_layout=mono:sample_rate=22050')
        .inputFormat('lavfi')
        .duration(duration)
        .output(outputPath)
        .on('end', async () => {
          try {
            const audioBuffer = await fs.readFile(outputPath);
            await fs.unlink(outputPath); // Cleanup temp file
            resolve(audioBuffer);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject)
        .run();
    });
    
  } catch (error) {
    logger.error('Error generating audio:', error);
    // Return minimal silent audio
    return Buffer.alloc(44100 * 2); // 1 second of silence
  }
}

async function createVideoFromScenes(scenesData, tempDir, durationPerScene) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(tempDir, `final_video_${Date.now()}.mp4`);
    const command = ffmpeg();

    // Add all images and audio files
    scenesData.forEach((scene, index) => {
      command.input(scene.imagePath);
      command.input(scene.audioPath);
    });

    // Build complex filter for combining scenes
    let filterComplex = '';
    let audioInputs = '';
    
    scenesData.forEach((scene, index) => {
      const imageIndex = index * 2;
      const audioIndex = index * 2 + 1;
      
      // Scale and pad image
      filterComplex += `[${imageIndex}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,setsar=1[v${index}];`;
      
      // Adjust audio duration
      filterComplex += `[${audioIndex}:a]apad=pad_dur=${durationPerScene}[a${index}];`;
      
      audioInputs += `[a${index}]`;
    });

    // Concatenate video and audio
    filterComplex += scenesData.map((_, i) => `[v${i}]`).join('') + 
                    `concat=n=${scenesData.length}:v=1:a=0[outv];`;
    filterComplex += audioInputs + `concat=n=${scenesData.length}:v=0:a=1[outa]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map', '[outv]', '-map', '[outa]'])
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .fps(24)
      .on('end', () => {
        logger.info('Video creation completed');
        resolve(outputPath);
      })
      .on('error', (error) => {
        logger.error('Error creating video:', error);
        reject(error);
      })
      .run();
  });
}

async function processStoryGeneration(taskId, storyRequest) {
  let tempDir;
  const tempFiles = [];
  
  try {
    updateProgress(taskId, 'generating_story', 10, 'Generating story structure...', 'story_generation');
    
    // Create temporary directory
    tempDir = `temp/${taskId}`;
    await fs.mkdir(tempDir, { recursive: true });
    
    // Generate structured story
    const storyData = await generateStructuredStory(
      storyRequest.theme,
      storyRequest.sceneCount,
      storyRequest.characterDescription
    );
    
    updateProgress(taskId, 'generating_images', 30, 'Generating scene images...', 'image_generation');
    
    // Generate images for each scene
    const scenesWithFiles = [];
    for (let i = 0; i < storyData.scenes.length; i++) {
      const scene = storyData.scenes[i];
      updateProgress(taskId, 'generating_images', 30 + (i * 20) / storyData.scenes.length,
                    `Generating image for scene ${i + 1}...`, 'image_generation');
      
      const imageData = await generateSceneImage(scene, storyData.characters);
      const imagePath = path.join(tempDir, `scene_${i + 1}.png`);
      
      await fs.writeFile(imagePath, imageData);
      tempFiles.push(imagePath);
      
      scene.imagePath = imagePath;
      scenesWithFiles.push(scene);
    }
    
    updateProgress(taskId, 'generating_audio', 50, 'Generating audio narration...', 'audio_generation');
    
    // Generate audio for each scene
    for (let i = 0; i < scenesWithFiles.length; i++) {
      const scene = scenesWithFiles[i];
      updateProgress(taskId, 'generating_audio', 50 + (i * 20) / scenesWithFiles.length,
                    `Generating audio for scene ${i + 1}...`, 'audio_generation');
      
      const audioData = await generateSceneAudio(scene.narration);
      const audioPath = path.join(tempDir, `scene_${i + 1}.wav`);
      
      await fs.writeFile(audioPath, audioData);
      tempFiles.push(audioPath);
      
      scene.audioPath = audioPath;
    }
    
    updateProgress(taskId, 'creating_video', 70, 'Creating final video...', 'video_creation');
    
    // Create final video
    const videoPath = await createVideoFromScenes(scenesWithFiles, tempDir, storyRequest.videoDurationPerScene);
    
    // Store video info
    generatedVideos.set(taskId, videoPath);
    
    updateProgress(taskId, 'completed', 100, 'Video generation completed!', 'completed');
    
  } catch (error) {
    logger.error(`Error in story generation task ${taskId}:`, error);
    updateProgress(taskId, 'failed', 0, `Error: ${error.message}`, 'failed');
  } finally {
    // Cleanup temporary files (keep video)
    for (const tempFile of tempFiles) {
      try {
        if (!generatedVideos.has(taskId) || tempFile !== generatedVideos.get(taskId)) {
          await fs.unlink(tempFile);
        }
      } catch (error) {
        logger.warn(`Failed to cleanup temp file ${tempFile}:`, error);
      }
    }
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    genaiClient: !!genaiClient
  });
});

app.post('/api/generate-story', async (req, res) => {
  try {
    if (!genaiClient) {
      return res.status(500).json({ error: 'GenAI client not initialized' });
    }

    const {
      theme,
      sceneCount = 3,
      characterDescription = '',
      videoDurationPerScene = 5
    } = req.body;

    if (!theme) {
      return res.status(400).json({ error: 'Theme is required' });
    }

    // Validate inputs
    if (sceneCount < 1 || sceneCount > 8) {
      return res.status(400).json({ error: 'Scene count must be between 1 and 8' });
    }

    if (videoDurationPerScene < 2 || videoDurationPerScene > 10) {
      return res.status(400).json({ error: 'Duration per scene must be between 2 and 10 seconds' });
    }

    // Create unique task ID
    const taskId = uuidv4();

    // Initialize progress
    updateProgress(taskId, 'pending', 0, 'Task queued for processing', 'queued');

    // Start background processing
    const storyRequest = {
      theme,
      sceneCount,
      characterDescription,
      videoDurationPerScene
    };
    
    // Run async without blocking
    processStoryGeneration(taskId, storyRequest).catch(error => {
      logger.error(`Background task error for ${taskId}:`, error);
    });

    res.json({
      taskId,
      message: 'Story generation started',
      estimatedDuration: '2-5 minutes'
    });

  } catch (error) {
    logger.error('Error in generate-story endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/progress/:taskId', (req, res) => {
  const { taskId } = req.params;

  if (!taskProgress.has(taskId)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const progressData = taskProgress.get(taskId);

  res.json({
    taskId,
    status: progressData.status,
    progress: progressData.progress,
    message: progressData.message,
    currentStep: progressData.currentStep,
    updatedAt: progressData.updatedAt
  });
});

app.get('/api/download/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!generatedVideos.has(videoId)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const videoPath = generatedVideos.get(videoId);

    try {
      await fs.access(videoPath);
    } catch {
      return res.status(404).json({ error: 'Video file not found' });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="animated_story_${videoId}.mp4"`);
    
    const videoBuffer = await fs.readFile(videoPath);
    res.send(videoBuffer);

  } catch (error) {
    logger.error('Error in download endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/videos/:videoId/info', async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!generatedVideos.has(videoId)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!taskProgress.has(videoId) || taskProgress.get(videoId).status !== 'completed') {
      return res.status(400).json({ error: 'Video not ready' });
    }

    const videoPath = generatedVideos.get(videoId);

    // Get video duration (simplified)
    let duration = 0;
    try {
      duration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration || 0);
        });
      });
    } catch {
      duration = 0;
    }

    res.json({
      taskId: videoId,
      videoUrl: `/api/download/${videoId}`,
      duration,
      sceneCount: 3 // This should come from stored metadata
    });

  } catch (error) {
    logger.error('Error in video info endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`🚀 Animated Story API server running on http://localhost:${PORT}`);
});

module.exports = app;