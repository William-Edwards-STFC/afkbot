import cv2
import numpy as np
import bettercam
import pytesseract
import time
import random
import re
from pynput.mouse import Button, Controller as MouseController
from pynput.keyboard import Key, Controller as KeyboardController

# ==========================================
# 1. CALIBRATION & CONFIGURATION
# ==========================================

# OCR SETTINGS: Calibrated based on your provided pixel coordinates
# (left_x, top_y, width, height)
COORD_ROI = (8, 31, 303, 27) 

# MONITOR SETTINGS: Set to 0 for your main monitor
MONITOR_INDEX = 0

# BOUNDARY SETTINGS: The safe X and Z coordinates on your cloud
# !!! ADJUST THESE TO MATCH YOUR ACTUAL CLOUD COORDINATES !!!
MIN_X, MAX_X = -1845, -1861
MIN_Z, MAX_Z = -289, -271

# TARGETING SETTINGS
# HSV Color Range for Birch Bark (White/Gray)
LOWER_BIRCH = np.array([0, 0, 180])
UPPER_BIRCH = np.array([180, 30, 255])

# Vertical pixel height threshold for 'Final Stage' trees
# Adjust this if the bot ignores mature trees or hits small ones
STAGE_4_HEIGHT_MIN = 130 

# Tesseract Path: Ensure this points to your actual installation
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# ==========================================
# 2. BOT CORE FUNCTIONS
# ==========================================

mouse = MouseController()
keyboard = KeyboardController()
# Initialize camera on the main monitor
camera = bettercam.create(output_idx=MONITOR_INDEX)

def get_current_coords(frame):
    """Crops the HUD ROI and extracts X, Z via OCR."""
    try:
        # Crop to your HUD location
        roi = frame[COORD_ROI[1]:COORD_ROI[1]+COORD_ROI[3], COORD_ROI[0]:COORD_ROI[0]+COORD_ROI[2]]
        
        # Pre-process for OCR (High contrast)
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
        
        # Run OCR
        text = pytesseract.image_to_string(thresh, config='--psm 7')
        
        # Extract numbers (Handles negatives and decimals)
        nums = re.findall(r"[-+]?\d+", text)
        
        if len(nums) >= 3:
            # Assumes format: X, Y, Z. We return X and Z.
            return float(nums[0]), float(nums[2])
    except Exception:
        pass
    return None, None

def is_safe(x, z):
    """Boundary check."""
    if x is None or z is None: return True 
    return MIN_X <= x <= MAX_X and MIN_Z <= z <= MAX_Z

def human_click():
    """Simulated natural click."""
    mouse.press(Button.left)
    time.sleep(random.uniform(0.07, 0.13))
    mouse.release(Button.left)

def human_move_mouse(tx, ty):
    """Stealthy mouse movement."""
    current_x, current_y = mouse.position
    steps = 6
    for i in range(steps):
        nx = current_x + (tx - current_x) * (i / steps) + random.randint(-1, 1)
        ny = current_y + (ty - current_y) * (i / steps) + random.randint(-1, 1)
        mouse.position = (nx, ny)
        time.sleep(0.01)

# ==========================================
# 3. MAIN HARVESTING LOOP
# ==========================================

print(f"Bot starting on Monitor {MONITOR_INDEX} in 5 seconds...")
time.sleep(5)

while True:
    frame = camera.grab()
    if frame is None: continue

    # PHASE 1: BOUNDARY CHECK
    curr_x, curr_z = get_current_coords(frame)
    if not is_safe(curr_x, curr_z):
        print(f"OUT OF BOUNDS: ({curr_x}, {curr_z}). Walking back...")
        keyboard.press('s')
        time.sleep(1.2)
        keyboard.release('s')
        continue

    # PHASE 2: TREE DETECTION
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, LOWER_BIRCH, UPPER_BIRCH)
    
    # Noise reduction
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    target_found = False
    sorted_contours = sorted(contours, key=lambda c: cv2.boundingRect(c)[3], reverse=True)

    for cnt in sorted_contours:
        bx, by, bw, bh = cv2.boundingRect(cnt)
        
        # Height check for Stage 4
        if bh >= STAGE_4_HEIGHT_MIN:
            target_found = True
            tx = bx + (bw // 2)
            ty = by + (bh // 2)

            human_move_mouse(tx, ty)
            
            # Distance check (using width as a proxy for distance)
            if bw < 45:
                keyboard.press('w')
                time.sleep(0.2)
                keyboard.release('w')
            else:
                print(f"Harvesting Stage 4 Tree (Height: {bh}px)")
                for _ in range(12): 
                    human_click()
                    time.sleep(random.uniform(0.18, 0.32))
                time.sleep(1.0) # Wait for wood to break
                break 

    if not target_found:
        # Slow rotation search
        keyboard.press('d')
        time.sleep(0.06)
        keyboard.release('d')
        time.sleep(0.1)