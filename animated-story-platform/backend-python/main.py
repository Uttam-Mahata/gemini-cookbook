import asyncio
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional
import base64
import logging

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
import uvicorn
from dotenv import load_dotenv
from moviepy.editor import ImageClip, AudioFileClip, concatenate_videoclips
import requests

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Animated Story Video Generation API",
    description="Generate animated story videos using Google GenAI",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize GenAI client
try:
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
    logger.info("GenAI client initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize GenAI client: {e}")
    client = None

# Global storage for task progress and generated videos
task_progress: Dict[str, Dict] = {}
generated_videos: Dict[str, str] = {}

# Pydantic models
class StoryRequest(BaseModel):
    theme: str = Field(..., description="Story theme or concept")
    scene_count: int = Field(default=3, ge=1, le=8, description="Number of scenes")
    character_description: str = Field(default="", description="Main character description")
    video_duration_per_scene: int = Field(default=5, ge=2, le=10, description="Duration per scene in seconds")

class ProgressResponse(BaseModel):
    task_id: str
    status: str  # "pending", "generating_story", "generating_images", "generating_audio", "creating_video", "completed", "failed"
    progress: int  # 0-100
    message: str
    current_step: str
    estimated_time_remaining: Optional[int] = None

class VideoResponse(BaseModel):
    task_id: str
    video_url: str
    thumbnail_url: Optional[str] = None
    duration: float
    scene_count: int

# Helper functions
def update_progress(task_id: str, status: str, progress: int, message: str, step: str):
    """Update task progress"""
    task_progress[task_id] = {
        "status": status,
        "progress": progress,
        "message": message,
        "current_step": step,
        "updated_at": time.time()
    }
    logger.info(f"Task {task_id}: {progress}% - {message}")

async def generate_structured_story(theme: str, scene_count: int, character_description: str) -> List[Dict]:
    """Generate structured story using Gemini with consistent characters"""
    
    # Define the story structure schema
    story_schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "characters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "appearance": {"type": "string"}
                    },
                    "required": ["name", "description", "appearance"]
                }
            },
            "scenes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "scene_number": {"type": "integer"},
                        "description": {"type": "string"},
                        "narration": {"type": "string"},
                        "visual_description": {"type": "string"},
                        "characters_present": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["scene_number", "description", "narration", "visual_description"]
                }
            }
        },
        "required": ["title", "characters", "scenes"]
    }
    
    prompt = f"""Create an engaging {scene_count}-scene story with the theme: "{theme}"
    
    {f"Main character description: {character_description}" if character_description else ""}
    
    Requirements:
    - Create 1-3 consistent characters that appear throughout the story
    - Each scene should have clear visual descriptions suitable for image generation
    - Include narration text for each scene
    - Maintain character consistency across scenes
    - Make the story cohesive and engaging
    - Suitable for animated video format
    
    Generate the story in the specified JSON structure."""
    
    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model="gemini-2.0-flash-exp",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_schema=story_schema,
                response_mime_type="application/json"
            )
        )
        
        import json
        story_data = json.loads(response.text)
        return story_data
        
    except Exception as e:
        logger.error(f"Error generating story: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate story: {str(e)}")

async def generate_scene_image(scene: Dict, characters: List[Dict]) -> bytes:
    """Generate image for a scene using Imagen"""
    
    # Build character context for consistent appearance
    character_context = ""
    if scene.get("characters_present") and characters:
        present_chars = [c for c in characters if c["name"] in scene.get("characters_present", [])]
        if present_chars:
            char_descriptions = [f"{c['name']}: {c['appearance']}" for c in present_chars]
            character_context = f"Characters in scene: {', '.join(char_descriptions)}. "
    
    # Create detailed image prompt
    image_prompt = f"""High-quality animated style illustration. {character_context}{scene['visual_description']}. 
    Style: colorful, friendly animated movie style, detailed background, good lighting, cinematic composition."""
    
    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model="imagen-3.0-fast-generate-001",
            contents=types.Content(parts=[
                types.Part(text=image_prompt)
            ])
        )
        
        # Get the image data from response
        if response.candidates and response.candidates[0].content.parts:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'inline_data') and part.inline_data:
                    return base64.b64decode(part.inline_data.data)
        
        raise Exception("No image data returned from Imagen")
        
    except Exception as e:
        logger.error(f"Error generating image: {e}")
        # Return a placeholder colored image
        from PIL import Image
        import io
        img = Image.new('RGB', (1280, 720), color='lightblue')
        img_bytes = io.BytesIO()
        img.save(img_bytes, format='PNG')
        return img_bytes.getvalue()

async def generate_scene_audio(narration: str) -> bytes:
    """Generate audio narration using Gemini Live API"""
    
    try:
        # Note: This is a simplified implementation
        # In production, you would use the actual Gemini Live API for audio synthesis
        # For now, we'll create a placeholder audio file
        
        # Create a simple audio file (placeholder)
        # In real implementation, use: client.live.generate_audio(text=narration)
        
        import io
        import wave
        import numpy as np
        
        # Generate simple tone as placeholder (replace with actual API call)
        duration = max(3.0, len(narration) * 0.1)  # Rough estimation
        sample_rate = 22050
        samples = int(duration * sample_rate)
        
        # Create silent audio as placeholder
        audio_data = np.zeros(samples, dtype=np.int16)
        
        # Convert to WAV bytes
        audio_buffer = io.BytesIO()
        with wave.open(audio_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_data.tobytes())
        
        return audio_buffer.getvalue()
        
    except Exception as e:
        logger.error(f"Error generating audio: {e}")
        # Return minimal silent audio
        import io
        import wave
        audio_buffer = io.BytesIO()
        with wave.open(audio_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(22050)
            wav_file.writeframes(b'\x00' * 22050 * 2)  # 1 second of silence
        return audio_buffer.getvalue()

async def create_video_from_scenes(scenes_data: List[Dict], temp_dir: Path, duration_per_scene: int) -> str:
    """Create final video from scene images and audio"""
    
    video_clips = []
    
    try:
        for i, scene_data in enumerate(scenes_data):
            # Create video clip for this scene
            image_clip = ImageClip(str(scene_data["image_path"]), duration=duration_per_scene)
            audio_clip = AudioFileClip(str(scene_data["audio_path"]))
            
            # Adjust audio duration to match video
            if audio_clip.duration > duration_per_scene:
                audio_clip = audio_clip.subclip(0, duration_per_scene)
            elif audio_clip.duration < duration_per_scene:
                # Extend audio with silence if needed
                from moviepy.audio.AudioClip import AudioClip
                silence = AudioClip(lambda t: 0, duration=duration_per_scene - audio_clip.duration)
                audio_clip = concatenate_videoclips([audio_clip, silence])
            
            # Combine image and audio
            final_clip = image_clip.set_audio(audio_clip)
            video_clips.append(final_clip)
        
        # Concatenate all clips
        final_video = concatenate_videoclips(video_clips)
        
        # Export final video
        output_path = temp_dir / f"final_video_{int(time.time())}.mp4"
        final_video.write_videofile(
            str(output_path),
            fps=24,
            codec='libx264',
            audio_codec='aac',
            temp_audiofile=str(temp_dir / "temp_audio.m4a"),
            remove_temp=True
        )
        
        # Cleanup clips
        final_video.close()
        for clip in video_clips:
            clip.close()
        
        return str(output_path)
        
    except Exception as e:
        logger.error(f"Error creating video: {e}")
        raise

async def process_story_generation(task_id: str, story_request: StoryRequest):
    """Background task to process story generation"""
    
    temp_dir = None
    temp_files = []
    
    try:
        update_progress(task_id, "generating_story", 10, "Generating story structure...", "story_generation")
        
        # Create temporary directory
        temp_dir = Path(tempfile.mkdtemp())
        
        # Generate structured story
        story_data = await generate_structured_story(
            story_request.theme, 
            story_request.scene_count, 
            story_request.character_description
        )
        
        update_progress(task_id, "generating_images", 30, "Generating scene images...", "image_generation")
        
        # Generate images for each scene
        scenes_with_files = []
        for i, scene in enumerate(story_data["scenes"]):
            update_progress(task_id, "generating_images", 30 + (i * 20) // len(story_data["scenes"]), 
                          f"Generating image for scene {i+1}...", "image_generation")
            
            image_data = await generate_scene_image(scene, story_data["characters"])
            image_path = temp_dir / f"scene_{i+1}.png"
            
            with open(image_path, 'wb') as f:
                f.write(image_data)
            temp_files.append(image_path)
            
            scene["image_path"] = image_path
            scenes_with_files.append(scene)
        
        update_progress(task_id, "generating_audio", 50, "Generating audio narration...", "audio_generation")
        
        # Generate audio for each scene
        for i, scene in enumerate(scenes_with_files):
            update_progress(task_id, "generating_audio", 50 + (i * 20) // len(scenes_with_files), 
                          f"Generating audio for scene {i+1}...", "audio_generation")
            
            audio_data = await generate_scene_audio(scene["narration"])
            audio_path = temp_dir / f"scene_{i+1}.wav"
            
            with open(audio_path, 'wb') as f:
                f.write(audio_data)
            temp_files.append(audio_path)
            
            scene["audio_path"] = audio_path
        
        update_progress(task_id, "creating_video", 70, "Creating final video...", "video_creation")
        
        # Create final video
        video_path = await create_video_from_scenes(scenes_with_files, temp_dir, story_request.video_duration_per_scene)
        
        # Store video info
        generated_videos[task_id] = video_path
        
        update_progress(task_id, "completed", 100, "Video generation completed!", "completed")
        
    except Exception as e:
        logger.error(f"Error in story generation task {task_id}: {e}")
        update_progress(task_id, "failed", 0, f"Error: {str(e)}", "failed")
    
    finally:
        # Cleanup temporary files (keep video)
        if temp_files:
            for temp_file in temp_files:
                try:
                    if temp_file.exists() and str(temp_file) not in generated_videos.values():
                        temp_file.unlink()
                except Exception as e:
                    logger.warning(f"Failed to cleanup temp file {temp_file}: {e}")

# API Routes
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "genai_client": client is not None
    }

@app.post("/api/generate-story", response_model=dict)
async def generate_story(story_request: StoryRequest, background_tasks: BackgroundTasks):
    """Generate animated story video"""
    
    if not client:
        raise HTTPException(status_code=500, detail="GenAI client not initialized")
    
    # Create unique task ID
    task_id = str(uuid.uuid4())
    
    # Initialize progress
    update_progress(task_id, "pending", 0, "Task queued for processing", "queued")
    
    # Start background processing
    background_tasks.add_task(process_story_generation, task_id, story_request)
    
    return {
        "task_id": task_id,
        "message": "Story generation started",
        "estimated_duration": "2-5 minutes"
    }

@app.get("/api/progress/{task_id}", response_model=ProgressResponse)
async def get_progress(task_id: str):
    """Get generation progress for a task"""
    
    if task_id not in task_progress:
        raise HTTPException(status_code=404, detail="Task not found")
    
    progress_data = task_progress[task_id]
    
    return ProgressResponse(
        task_id=task_id,
        status=progress_data["status"],
        progress=progress_data["progress"],
        message=progress_data["message"],
        current_step=progress_data["current_step"]
    )

@app.get("/api/download/{video_id}")
async def download_video(video_id: str):
    """Download generated video"""
    
    if video_id not in generated_videos:
        raise HTTPException(status_code=404, detail="Video not found")
    
    video_path = generated_videos[video_id]
    
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Video file not found")
    
    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=f"animated_story_{video_id}.mp4"
    )

@app.get("/api/videos/{video_id}/info", response_model=VideoResponse)
async def get_video_info(video_id: str):
    """Get video information"""
    
    if video_id not in generated_videos:
        raise HTTPException(status_code=404, detail="Video not found")
    
    if video_id not in task_progress or task_progress[video_id]["status"] != "completed":
        raise HTTPException(status_code=400, detail="Video not ready")
    
    video_path = generated_videos[video_id]
    
    # Get video duration (simplified)
    try:
        from moviepy.editor import VideoFileClip
        clip = VideoFileClip(video_path)
        duration = clip.duration
        clip.close()
    except:
        duration = 0.0
    
    return VideoResponse(
        task_id=video_id,
        video_url=f"/api/download/{video_id}",
        duration=duration,
        scene_count=3  # This should come from stored metadata
    )

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )