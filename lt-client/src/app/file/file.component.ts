import { Component, OnInit } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as e from 'express';
import { map, Observable, startWith } from 'rxjs';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-file',
  templateUrl: './file.component.html',
  styleUrls: ['./file.component.scss']
})
export class FileComponent implements OnInit {

  constructor(private apiService: ApiService, private route: ActivatedRoute, private router: Router) { }

  file: { file: string, existingTags: string[], description: string } | null = null
  isVid = false
  allTags: string[] = []
  filteredTags: Observable<string[]> | undefined

  tag = new FormControl('')
  descriptionAppend = new FormControl('')

  async ngOnInit() {
    this.filteredTags = this.tag.valueChanges.pipe(
      startWith(''),
      map(value => this._filter(value)),
    );
    try {
      let f = this.route.snapshot.paramMap.get('file')
      if (!f) this.router.navigate(['/files'])
      else {
        this.allTags = await this.apiService.getTags()
        this.file = await this.apiService.getFileInfo(f)
      }
    } catch (err) {
      console.error(err)
    }
    if (this.file) {
      let ext = this.file.file.slice(this.file.file.lastIndexOf('.') + 1).toLowerCase()
      this.isVid = ['mp4', '3gp', 'avi', 'mov'].includes(ext)
    }
  }

  toggleIsVid() {
    this.isVid = !this.isVid
  }

  private _filter(value: string): string[] {
    const filterValue = this.parseTag(value)
    return this.allTags.filter(option => option.includes(filterValue))
  }

  removeTag(tag: string) {
    if (this.file) {
      this.file.existingTags = this.file.existingTags.filter(t => t !== tag)
      this.allTags = this.allTags.filter(t => t !== tag)
    }
  }

  parseTag(tag: string) {
    if (tag) return tag.toLowerCase().split(',').filter((word: string) => word.trim().length > 0).join(' ').split(' ').filter((word: string) => word.trim().length > 0).join('-')
    else return ''
  }

  addTag(e: Event) {
    e.preventDefault()
    if (this.file && this.tag.value) {
      let tag = this.parseTag(this.tag.value)
      this.file.existingTags.push(tag)
      this.allTags.push(tag)
      this.tag.reset()
      this.file.existingTags = Array.from(new Set(this.file.existingTags))
    }
  }

  async submit(e: Event) {
    e.preventDefault()
    if (this.file) {
      try {
        await this.apiService.updateFileInfo(this.file.file,
          this.file.existingTags,
          this.descriptionAppend.value
        )
        this.router.navigate(['/files'])
      } catch (err) {
        console.error(err)
      }
    }
  }

}
