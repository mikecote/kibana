#!/bin/bash

# Define the source file
source_file="task_manager_capacity_based_claiming.test.ts"

# Extract filename without extension and the extension itself
filename="${source_file%.*}"
extension="${source_file##*.}"

# Loop to create 50 copies
for i in {1..50}; do
    cp "$source_file" "${filename}_${i}.${extension}"
done
